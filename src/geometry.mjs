import { escapeHtml } from './lib/validation.mjs';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// spec: { width, height, shapes: [{type:'line'|'rect'|'text', ...}] }
// 输出内联 SVG 字符串；所有数值收敛为数字、所有文本转义，避免注入。
export function renderGeometry(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const width = Math.min(Math.max(num(spec.width, 400), 50), 2000);
  const height = Math.min(Math.max(num(spec.height, 300), 50), 2000);
  const shapes = Array.isArray(spec.shapes) ? spec.shapes : [];
  const body = shapes.map((shape) => {
    switch (shape.type) {
      case 'line':
        return `<line x1="${num(shape.x1)}" y1="${num(shape.y1)}" x2="${num(shape.x2)}" y2="${num(shape.y2)}" stroke="#333" stroke-width="${num(shape.width, 2)}" />`;
      case 'rect':
        return `<rect x="${num(shape.x)}" y="${num(shape.y)}" width="${num(shape.w)}" height="${num(shape.h)}" fill="none" stroke="#333" stroke-width="${num(shape.width, 2)}" />`;
      case 'text':
        return `<text x="${num(shape.x)}" y="${num(shape.y)}" font-size="${num(shape.size, 14)}" fill="#222">${escapeHtml(shape.text)}</text>`;
      default:
        return '';
    }
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="题目几何图">${body}</svg>`;
}
