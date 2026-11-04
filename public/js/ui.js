// 组件工厂：一律用 textContent 写用户数据，禁止 innerHTML 拼接。
// 这里只造 DOM，不发起请求、不写业务判断。

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function button(label, { variant = 'secondary', onClick, type = 'button', disabled = false } = {}) {
  const node = el('button', `btn btn--${variant}`, label);
  node.type = type;
  node.disabled = disabled;
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function link(label, href, className = '') {
  const node = el('a', className, label);
  node.href = href;
  return node;
}

export function card(title, { actions = [] } = {}) {
  const node = el('section', 'card');
  const head = el('div', 'card__head');
  head.append(el('h2', '', title));
  for (const action of actions) head.append(action);
  const body = el('div', 'card__body');
  node.append(head, body);
  return { node, body };
}

export function stateTag(status, label) {
  const node = el('span', `tag tag--${status}`);
  node.dataset.label = label || status;
  return node;
}

export function stat(value, label, href) {
  const box = el('div', 'card');
  const body = el('div', 'card__body');
  body.append(el('div', 'stat', value), el('div', 'stat-label', label));
  if (href) {
    const a = link('去看看 →', href, 'small');
    body.append(a);
  }
  box.append(body);
  return box;
}

export function empty(title, hint = '') {
  const box = el('div', 'empty');
  box.append(el('div', 'empty__title', title));
  if (hint) box.append(el('p', 'small', hint));
  return box;
}

export function alert(message, kind = 'info') {
  return el('div', `alert alert--${kind}`, message);
}

export function skeleton(lines = 3) {
  const box = el('div', 'stack');
  for (let i = 0; i < lines; i += 1) box.append(el('div', 'skeleton skeleton--line'));
  return box;
}

export function progress(steps, currentIndex) {
  const box = el('div', 'progress');
  const bar = el('div', 'progress__bar');
  const fill = el('span');
  fill.style.setProperty('--progress-value', `${Math.round(((currentIndex + 1) / steps.length) * 100)}%`);
  bar.append(fill);
  const row = el('div', 'progress__step');
  steps.forEach((name, index) => {
    const klass = index < currentIndex ? 'is-done' : index === currentIndex ? 'is-current' : '';
    row.append(el('div', klass, name));
  });
  box.append(bar, row);
  return box;
}

let toastTimer;
export function toast(message, kind = 'info') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', '');
    host.id = 'toast-host';
    document.body.append(host);
  }
  host.replaceChildren();
  const node = el('div', `toast${kind === 'error' ? ' toast--error' : ''}`, message);
  host.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.replaceChildren(), 3500);
}

export function questionCard(item, { withLines = false } = {}) {
  const node = el('article', 'qcard');
  const head = el('div', 'qcard__head');
  head.append(el('span', '', `#${item.id ?? '-'}`), el('span', '', item.subject_label || item.subject || ''));
  node.append(head);
  node.append(el('div', 'qcard__prompt', item.prompt || '（题干待补）'));
  if (item.image_path) {
    const img = el('img', 'qcard__figure');
    img.src = `/${item.image_path}`;
    img.alt = '题目照片';
    img.loading = 'lazy';
    node.append(img);
  }
  if (withLines) {
    const lines = el('div', 'qcard__lines');
    for (let i = 0; i < 3; i += 1) lines.append(el('div', 'qcard__line'));
    node.append(lines);
  }
  return node;
}
