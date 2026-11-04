import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { importLegacy, parseFrontmatter, parseVariants } from '../scripts/import-legacy.mjs';

let legacyRoot;
let dataDir;
let db;
const originals = new Map();

const MISTAKE_MD = (id, withVariants) => `---
id: ${id}
subject: math
grade: 3
semester: 2
type: 应用题
image_path: raw/math/${id}.png
knowledge_tags:
  - 铺砖问题
  - 面积应用
error_category: procedural
error_reason: 加法代替乘法
difficulty: 中等
status: reviewing
review_round: 2
next_review: 2026-05-28
variant_count: 3
mastered_at:
created: 2026-05-24
preliminary_diagnosis:
  error_category: procedural
  reason: 分步正确但最后一步错
  confidence: 0.75
---

## 病因诊断

| 维度 | 说明 |
| --- | --- |
| 病因 | 概念模糊 |

## 原题

导盲砖铺路，需要多少块？

## 学生答案

300+2=302

## 正确答案

300×2=600
${withVariants ? `
## 变式训练

### 变式一（表面变式）
换数字后的题干

**学生作答：**

225×4=900

**结果：通过 ✅**

### 变式二（结构变式）
换角度后的题干

**学生作答：**

800 块

**结果：通过 ✅**
` : ''}
`;

const TEXTBOOK_MD = `---
subject: math
edition: 人教版
grade: 4
semester: 1
---

| 单元 | 课题 | 教材起始页 |
| --- | --- | --- |
| 第一单元 | 大数的认识 | p2 |
| 第二单元 | 公顷和平方千米 | p34 |
`;

before(() => {
  legacyRoot = mkdtempSync(join(tmpdir(), 'ml-fixture-'));
  dataDir = mkdtempSync(join(tmpdir(), 'ml-import-'));
  mkdirSync(join(legacyRoot, 'wiki', 'mistakes'), { recursive: true });
  mkdirSync(join(legacyRoot, 'wiki', 'textbooks', 'math'), { recursive: true });
  mkdirSync(join(legacyRoot, 'raw', 'math'), { recursive: true });

  for (const [index, id] of ['M-TEST-001', 'M-TEST-002', 'M-TEST-003'].entries()) {
    const md = MISTAKE_MD(id, index === 0);
    const mdPath = join(legacyRoot, 'wiki', 'mistakes', `${id}.md`);
    const imagePath = join(legacyRoot, 'raw', 'math', `${id}.png`);
    writeFileSync(mdPath, md);
    writeFileSync(imagePath, Buffer.from(`fake-image-${id}`));
    originals.set(mdPath, md);
    originals.set(imagePath, readFileSync(imagePath));
  }
  writeFileSync(join(legacyRoot, 'wiki', 'textbooks', 'math', '人教版-四年级上册.md'), TEXTBOOK_MD);

  db = openDb(':memory:');
  migrate(db);
});

after(() => {
  closeDb(db);
  rmSync(legacyRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('只读导入', () => {
  it('frontmatter 与变式解析：空值、嵌套对象、列表、历史作答截断', () => {
    const { meta, body } = parseFrontmatter(MISTAKE_MD('M-X', true));
    assert.equal(meta.next_review, '2026-05-28');
    assert.equal(meta.mastered_at, '');
    assert.deepEqual(meta.knowledge_tags, ['铺砖问题', '面积应用']);
    assert.equal(meta.preliminary_diagnosis.reason, '分步正确但最后一步错');
    const variants = parseVariants(body.split('## 变式训练')[1]);
    assert.equal(variants.length, 2);
    assert.equal(variants[0].level, 'surface');
    assert.equal(variants[0].prompt, '换数字后的题干');
    assert.equal(variants[0].prompt.includes('学生作答'), false);
    assert.equal(variants[0].prompt.includes('结果：通过'), false);
  });

  it('I1-I4 首次导入：字段映射、三下不挂四上、图片复制、旧库原文件不变', () => {
    const result = importLegacy({ legacyRoot, dataDir, db });
    assert.equal(result.added.mistakes, 3);
    assert.equal(result.added.variants, 2);
    assert.equal(result.added.images, 3);
    assert.equal(result.added.textbookNodes, 2);
    assert.equal(result.added.awaitingTextbookRef, 3);
    assert.deepEqual(result.added.missingImages, []);

    const row = db.prepare("SELECT * FROM mistakes WHERE source_ref = 'M-TEST-001'").get();
    assert.equal(row.grade, 3);
    assert.equal(row.semester, 2);
    assert.equal(row.status, 'reviewing');
    assert.equal(row.review_round, 2);
    assert.equal(row.next_review, '2026-05-28');
    assert.equal(row.edition, '人教版');
    assert.equal(row.textbook_node_id, null, '三下题不得挂到四上节点');
    assert.equal(row.needs_textbook_ref, 1);
    assert.ok(row.diagnosis_note.startsWith('旧库初步诊断，未经教师审核'));
    assert.ok(row.prompt.includes('导盲砖'));

    const nodes = db.prepare('SELECT * FROM textbook_nodes ORDER BY unit_no').all();
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].unit_no, 1);
    assert.equal(nodes[1].unit_no, 2);
    assert.equal(nodes[0].grade, 4);
    assert.equal(nodes[0].semester, 1);

    for (const id of ['M-TEST-001', 'M-TEST-002', 'M-TEST-003']) {
      assert.ok(existsSync(join(dataDir, 'images', 'legacy', `${id}.png`)));
    }
    for (const [path, original] of originals) {
      const current = typeof original === 'string' ? readFileSync(path, 'utf8') : readFileSync(path);
      assert.deepEqual(current, original, `旧库文件不得被改动：${path}`);
    }
  });

  it('I5-I6 重复执行新增为 0；手写 variant_count 不入库', () => {
    const second = importLegacy({ legacyRoot, dataDir, db });
    assert.deepEqual(
      [second.added.mistakes, second.added.variants, second.added.images, second.added.textbookNodes],
      [0, 0, 0, 0],
    );
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mistakes').get().c, 3);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM variants').get().c, 2, '变式数按实际解析条目，不按 variant_count=3');
    const columns = db.prepare("PRAGMA table_info('mistakes')").all().map((c) => c.name);
    assert.equal(columns.includes('variant_count'), false);
  });
});
