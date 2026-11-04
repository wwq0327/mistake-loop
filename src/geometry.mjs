import { escapeHtml } from './lib/validation.mjs';

function num(value, fallback = 0) {
  // 空值与数字 0 要分开：Number(null) 是 0（有限数），直接转换会让 null 绕过 fallback——
  // 宽高被压到下限 50、线宽与字号变成 0，画出来的东西直接看不见（见 #47）。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// spec: { width, height, shapes: [{type:'line'|'rect'|'text', ...}] }
// 输出内联 SVG 字符串；所有数值收敛为数字、所有文本转义，避免注入。
// 颜色一律用 currentColor：SVG 内联在 DOM 里时它继承 --color-ink，
// 出纸层（print.css 把 --color-ink 重映射到 --print-ink）与深色模式都能接管。
// 写死 #333 之类的字面色值会绕开整套设计令牌，见 #44。
export function renderGeometry(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const width = Math.min(Math.max(num(spec.width, 400), 50), 2000);
  const height = Math.min(Math.max(num(spec.height, 300), 50), 2000);
  const shapes = Array.isArray(spec.shapes) ? spec.shapes : [];
  const body = shapes.map((shape) => {
    switch (shape.type) {
      case 'line':
        return `<line x1="${num(shape.x1)}" y1="${num(shape.y1)}" x2="${num(shape.x2)}" y2="${num(shape.y2)}" stroke="currentColor" stroke-width="${num(shape.width, 2)}" />`;
      case 'rect':
        return `<rect x="${num(shape.x)}" y="${num(shape.y)}" width="${num(shape.w)}" height="${num(shape.h)}" fill="none" stroke="currentColor" stroke-width="${num(shape.width, 2)}" />`;
      case 'text':
        return `<text x="${num(shape.x)}" y="${num(shape.y)}" font-size="${num(shape.size, 14)}" fill="currentColor">${escapeHtml(shape.text)}</text>`;
      default:
        return '';
    }
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="题目几何图">${body}</svg>`;
}
