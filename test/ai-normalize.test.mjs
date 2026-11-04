// #11 测试先行：识别结果清洗器（纯函数，零 IO、零外部请求）。
// 红灯预期：src/ai/normalize.mjs 不存在，import 失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRecognition,
  extractJson,
  LOW_CONFIDENCE,
  MAX_PROMPT_LENGTH,
} from '../src/ai/normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function question(overrides = {}) {
  return {
    seq: 1,
    bbox: [0.05, 0.1, 0.9, 0.3],
    subject_hint: 'math',
    prompt: '把 3.6 米长的绳子平均分成 4 段，每段长多少米？',
    options: [],
    student_answer_draft: '0.8',
    correct_answer_draft: null,
    question_type: '应用题',
    knowledge_hint: '小数除法',
    has_figure: false,
    figure_desc: '',
    confidence: { prompt: 0.94, student_answer: 0.9, subject_hint: 0.91 },
    uncertain: [],
    ...overrides,
  };
}

function payload(questions, extra = {}) {
  return JSON.stringify({ questions, page_note: '整页 1 题', ...extra });
}

test('脏 JSON：前后带解释文字与 markdown 代码块仍能提取，且只保留白名单字段', () => {
  const dirty = `好的，结果如下：\n\`\`\`json\n${payload([question({ evil_field: '注入', polluted: true })], { marker: 1 })}\n\`\`\`\n以上。`;
  const result = normalizeRecognition(dirty);
  assert.equal(result.ok, true);
  assert.equal(result.questions.length, 1);
  const q = result.questions[0];
  assert.equal(q.evil_field, undefined);
  assert.equal(q.marker, undefined);
  assert.equal(q.polluted, undefined);
  assert.equal(Object.getPrototypeOf(q), Object.prototype, '原型被注入字段污染');
  assert.equal(q.prompt, '把 3.6 米长的绳子平均分成 4 段，每段长多少米？');
  assert.equal(q.seq, 1);
  assert.equal(result.pageNote, '整页 1 题');
});

test('越界 bbox 一律置 null，合法框保留', () => {
  const result = normalizeRecognition(payload([
    question({ seq: 1, bbox: [1.4, -0.2, 0.9, 2] }),
    question({ seq: 2, bbox: [0.1, 0.4, 0.8, 0.6] }),
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.questions[0].bbox, null);
  assert.deepEqual(result.questions[1].bbox, [0.1, 0.4, 0.8, 0.6]);
  assert.equal(extractJson('无 JSON'), null);
});

test('超长文本按上限截断，raw_excerpt 不含图片 base64', () => {
  const long = '长'.repeat(MAX_PROMPT_LENGTH + 120);
  const result = normalizeRecognition(`data:image/jpeg;base64,${'A'.repeat(40)} ` + payload([question({ prompt: long })]));
  assert.equal(result.ok, true);
  assert.equal(result.questions[0].prompt.length, MAX_PROMPT_LENGTH);
  assert.ok(result.rawExcerpt.length <= 500);
  assert.ok(!result.rawExcerpt.includes('AAAAAAAAAA'), 'raw_excerpt 泄漏了图片 base64');
});

test('低置信度或模型自报 uncertain 的字段被清空并标记', () => {
  const result = normalizeRecognition(payload([question({
    confidence: { prompt: 0.95, student_answer: LOW_CONFIDENCE - 0.01, subject_hint: 0.9 },
  })]));
  assert.equal(result.ok, true);
  const q = result.questions[0];
  assert.equal(q.student_answer_draft, '', '低置信度字段未清空');
  assert.ok(q.uncertain.includes('student_answer'));
  assert.equal(q.prompt, '把 3.6 米长的绳子平均分成 4 段，每段长多少米？');

  const declared = normalizeRecognition(payload([question({ uncertain: ['knowledge_hint'] })]));
  assert.equal(declared.questions[0].knowledge_hint, '', '模型自报不确定字段未清空');
  assert.ok(declared.questions[0].uncertain.includes('knowledge_hint'));
});

test('correct_answer_draft 即使模型给了也一律标 needs_teacher_check', () => {
  const result = normalizeRecognition(payload([question({ correct_answer_draft: '0.9 米' })]));
  assert.equal(result.ok, true);
  assert.equal(result.questions[0].correct_answer_draft, '0.9 米');
  assert.equal(result.questions[0].correct_answer_needs_teacher_check, true);
  const absent = normalizeRecognition(payload([question()]));
  assert.equal(absent.questions[0].correct_answer_needs_teacher_check, true);
});

test('空题集 / 非数组 / 单题 prompt 为空一律判失败，不生成半截草稿', () => {
  assert.equal(normalizeRecognition(payload([])).ok, false);
  assert.equal(normalizeRecognition(JSON.stringify({ questions: '不是数组' })).ok, false);
  assert.equal(normalizeRecognition('完全没有 JSON').ok, false);
  assert.equal(normalizeRecognition(payload([question(), question({ prompt: '   ' })])).ok, false);
  assert.equal(normalizeRecognition(payload([question(), question({ prompt: '' })])).questions, undefined);
  assert.equal(normalizeRecognition(payload([])).errorCode, 'EMPTY_QUESTIONS');
});

test('置信度夹到 0-1，缺失补 0；subject_hint 非法值置空', () => {
  const result = normalizeRecognition(payload([question({
    confidence: { prompt: 5, student_answer: -2 },
    subject_hint: 'physics',
  })]));
  const q = result.questions[0];
  assert.equal(q.confidence.prompt, 1);
  assert.equal(q.confidence.student_answer, 0);
  assert.equal(q.confidence.question_type, 0, '缺失置信度未补 0');
  assert.equal(q.subject, null, '非法科目未置空');
});

test('纯函数：源码不引用任何 IO、环境变量或网络 API', () => {
  const source = readFileSync(join(here, '..', 'src', 'ai', 'normalize.mjs'), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]node:(fs|http|https|net|child_process)/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /require\s*\(/);
});
