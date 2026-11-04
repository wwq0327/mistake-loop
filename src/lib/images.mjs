import { writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validation.mjs';

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_BYTES = 15 * 1024 * 1024;
export const DERIVED_MAX_BYTES = 2 * 1024 * 1024;

// 先解析校验、再落盘：避免校验失败留下孤儿文件。
function parseImage(dataUrl, maxBytes) {
  if (typeof dataUrl !== 'string') throw new ValidationError('图片格式不正确', 'INVALID_IMAGE');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new ValidationError('只支持 png / jpg / webp / gif 图片', 'INVALID_IMAGE');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maxBytes) {
    throw new ValidationError('图片为空或超过大小上限', 'INVALID_IMAGE');
  }
  return { ext: MIME_EXT[match[1]], buffer };
}

function writeTo(dir, ext, buffer) {
  mkdirSync(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  writeFileSync(join(dir, filename), buffer);
  return filename;
}

// v1 行为不变：dataUrl -> images/<uuid>.<ext>
export function saveImage(dataUrl, dataDir) {
  const { ext, buffer } = parseImage(dataUrl, MAX_BYTES);
  return `images/${writeTo(join(dataDir, 'images'), ext, buffer)}`;
}

// v2：原图不压缩留在 images/，供上游使用的压缩图单独放 images/derived/。
// derived 为 null 表示前端压缩失败或未启用 AI：原图照常收件，但不发外部请求。
export function saveRecognitionPair({ original, derived, maxDerivedBytes = DERIVED_MAX_BYTES, sharedBasename = false }, dataDir) {
  const a = parseImage(original, MAX_BYTES);
  const b = derived === null || derived === undefined ? null : parseImage(derived, maxDerivedBytes);

  const imagesDir = join(dataDir, 'images');
  const originalPath = `images/${writeTo(imagesDir, a.ext, a.buffer)}`;
  let derivedPath = null;
  if (b) {
    // sharedBasename：压缩图与原图同名、只分目录，worker 无需额外字段即可找到。
    const derivedDir = join(imagesDir, 'derived');
    const filename = sharedBasename ? basename(originalPath) : `${randomUUID()}.${b.ext}`;
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, filename), b.buffer);
    derivedPath = `images/derived/${filename}`;
  }

  return {
    originalPath,
    derivedPath,
    originalBytes: a.buffer.length,
    derivedBytes: b ? b.buffer.length : null,
  };
}

// 只读导入用：复制旧库图片，basename 防目录穿越。
export function copyLegacyImage(srcPath, dataDir) {
  const targetDir = join(dataDir, 'images', 'legacy');
  mkdirSync(targetDir, { recursive: true });
  const filename = basename(srcPath);
  const target = join(targetDir, filename);
  if (!existsSync(target)) copyFileSync(srcPath, target);
  return `images/legacy/${filename}`;
}
