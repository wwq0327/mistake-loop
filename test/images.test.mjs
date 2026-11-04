// #6 测试先行：识别图片分原图与压缩图，超限与非法输入必须在落盘前被拒绝。
// 红灯预期：src/lib/images.mjs 尚无 saveRecognitionPair 导出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRecognitionPair, saveImage } from '../src/lib/images.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AKp//9k=';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-images-'));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('原图与压缩图分别落盘且内容可回读', () => {
  const s = scratch();
  try {
    const out = saveRecognitionPair({ original: PNG, derived: JPEG }, s.dir);
    assert.match(out.originalPath, /^images\//);
    assert.match(out.derivedPath, /^images\/derived\//);
    assert.ok(existsSync(join(s.dir, out.originalPath)));
    assert.ok(existsSync(join(s.dir, out.derivedPath)));
    assert.equal(readFileSync(join(s.dir, out.originalPath)).length > 0, true);
  } finally { s.clean(); }
});

test('压缩图超过上限时抛 INVALID_IMAGE，且不留下任何文件', () => {
  const s = scratch();
  try {
    assert.throws(
      () => saveRecognitionPair({ original: PNG, derived: JPEG, maxDerivedBytes: 20 }, s.dir),
      (err) => err.code === 'INVALID_IMAGE',
    );
    assert.equal(existsSync(join(s.dir, 'images')), false, '校验失败却落盘了文件');
  } finally { s.clean(); }
});

test('非法格式或不合法 base64 返回 400 级错误', () => {
  const s = scratch();
  try {
    assert.throws(() => saveRecognitionPair({ original: 'data:image/svg+xml;base64,AAAA', derived: PNG }, s.dir), (e) => e.code === 'INVALID_IMAGE');
    assert.throws(() => saveRecognitionPair({ original: 'not-a-data-url', derived: PNG }, s.dir), (e) => e.code === 'INVALID_IMAGE');
  } finally { s.clean(); }
});

test('缺压缩图时原图照常收件，derivedPath 为 null（不发上游）', () => {
  const s = scratch();
  try {
    const out = saveRecognitionPair({ original: PNG, derived: null }, s.dir);
    assert.ok(out.originalPath);
    assert.equal(out.derivedPath, null);
    assert.ok(existsSync(join(s.dir, out.originalPath)));
  } finally { s.clean(); }
});

test('v1 的 saveImage 行为不变', () => {
  const s = scratch();
  try {
    const path = saveImage(PNG, s.dir);
    assert.match(path, /^images\/[0-9a-f-]+\.png$/);
    assert.ok(existsSync(join(s.dir, path)));
  } finally { s.clean(); }
});
