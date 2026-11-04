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

// dataUrl -> images/<uuid>.<ext>，返回相对 data 目录的路径。
export function saveImage(dataUrl, dataDir) {
  if (typeof dataUrl !== 'string') throw new ValidationError('图片格式不正确', 'INVALID_IMAGE');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new ValidationError('只支持 png / jpg / webp / gif 图片', 'INVALID_IMAGE');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES) {
    throw new ValidationError('图片为空或超过 15MB', 'INVALID_IMAGE');
  }
  const imagesDir = join(dataDir, 'images');
  mkdirSync(imagesDir, { recursive: true });
  const filename = `${randomUUID()}.${MIME_EXT[match[1]]}`;
  writeFileSync(join(imagesDir, filename), buffer);
  return `images/${filename}`;
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
