// 最小 DOM 垫片：给 public/js 里的页面代码一个能真跑的 DOM。
// 零依赖原则，不引 jsdom；也不模拟浏览器渲染，只模拟「节点能不能被造出来、
// 挂上去、按顺序排、事件能不能触发」。
// 用途：题目详情页、收件箱这类页面光靠读源码断言不够——「按钮在不在、
// 点了调哪个接口」必须真跑一遍才算数。
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK = 'http://www.w3.org/1999/xhtml';

export class ShimNode {
  constructor(tag, namespaceURI = XLINK) {
    this.tagName = tag;
    this.localName = tag;
    this.namespaceURI = namespaceURI;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.style = { setProperty() {} };
    this.id = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.type = '';
    this.src = '';
    this.alt = '';
    this.rows = 0;
    this.files = [];
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
      toggle: (name) => (classes.has(name) ? classes.delete(name) : classes.add(name)),
    };
    // className 与 classList 同源：HTML 里写 class="a b"，JS 里 add('c')。
    this.className = '';
    Object.defineProperty(this, 'className', {
      get() { return [...classes].join(' '); },
      set(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n)); },
      configurable: true,
    });
  }

  append(...nodes) { this.children.push(...nodes); }

  replaceChildren(...nodes) { this.children = [...nodes]; }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name) { delete this.attributes[name]; }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  // 触发事件：模拟浏览器把事件对象交给监听器，返回所有监听器的执行结果。
  dispatch(type, event = {}) {
    const payload = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    const results = [];
    for (const handler of this.listeners.get(type) || []) results.push(handler(payload));
    return results;
  }

  click() { return this.dispatch('click'); }

  focus() { this.focused = true; }

  scrollIntoView() { this.scrolled = true; }

  getContext() { return null; }

  toDataURL() { return 'data:image/png;base64,'; }

  descendants() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child instanceof ShimNode) { out.push(child); walk(child); }
      }
    };
    walk(this);
    return out;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => matches(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

// 汇总一棵子树的文字：ShimNode.textContent 只是自己的字符串，
// 不会像真 DOM 那样自动拼上子节点的文字，测试要用这个取整棵树的文案。
export function textOf(node) {
  if (!node) return '';
  const own = typeof node.textContent === 'string' ? node.textContent : '';
  const kids = (node.children || [])
    .map((child) => (child instanceof ShimNode ? textOf(child) : (child?.text ?? '')))
    .join('');
  return own + kids;
}

// 选择器只支持页面代码实际用到的几种：#id、.class、tag、[attr] 及其组合。
export function matches(node, selector) {
  return selector.split(',').map((s) => s.trim()).filter(Boolean).some((part) => {
    const conditions = part.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*/g) || [];
    return conditions.every((cond) => {
      if (cond.startsWith('#')) return node.id === cond.slice(1);
      if (cond.startsWith('.')) return node.classList.contains(cond.slice(1));
      if (cond.startsWith('[')) {
        const m = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(cond);
        if (!m) return false;
        const value = node.getAttribute(m[1]);
        if (value === null) return false;
        return m[2] === undefined || value === m[2];
      }
      return node.localName === cond;
    });
  });
}

// XML 解析：够用且够严。标签没闭合、根元素不是一个，都给 parsererror——
// 跟真浏览器对齐，否则「非法内容不出坏节点」这类断言就是自欺欺人。
export function parseXml(text) {
  const container = new ShimNode('#container', SVG_NS);
  const stack = [container];
  const re = /<\s*(\/?)\s*([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let match = re.exec(text);
  while (match !== null) {
    if (match[5] !== undefined) {
      if (match[5].trim()) stack[stack.length - 1].children.push({ text: match[5] });
    } else if (match[1] === '/') {
      if (stack.length === 1) return null;
      stack.pop();
    } else {
      const node = new ShimNode(match[2], SVG_NS);
      for (const attr of (match[3] || '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
        node.setAttribute(attr[1], attr[2]);
      }
      stack[stack.length - 1].children.push(node);
      if (match[4] !== '/') stack.push(node);
    }
    match = re.exec(text);
  }
  if (stack.length !== 1) return null;
  const roots = container.children.filter((child) => child instanceof ShimNode);
  return roots.length === 1 ? roots[0] : null;
}

export function cloneNode(node) {
  const copy = new ShimNode(node.localName, node.namespaceURI);
  copy.className = node.className;
  copy.textContent = node.textContent;
  for (const [key, value] of Object.entries(node.attributes)) copy.setAttribute(key, value);
  for (const child of node.children) {
    copy.children.push(child instanceof ShimNode ? cloneNode(child) : { ...child });
  }
  return copy;
}

export class ShimDOMParser {
  parseFromString(text, mimeType) {
    if (mimeType !== 'image/svg+xml') return { documentElement: new ShimNode('parsererror') };
    const root = parseXml(String(text));
    return { documentElement: root || new ShimNode('parsererror') };
  }
}

// 装一套 DOM 到 globalThis，返回把手供测试查节点。
export function installDom({ ids = [] } = {}) {
  const registry = new Map();
  const body = new ShimNode('body');

  const getElementById = (id) => {
    if (!registry.has(id)) {
      const node = new ShimNode('div');
      node.id = id;
      registry.set(id, node);
    }
    return registry.get(id);
  };

  const document = {
    body,
    getElementById,
    createElement: (tag) => new ShimNode(tag),
    createElementNS: (ns, tag) => new ShimNode(tag, ns),
    importNode: (node) => cloneNode(node),
    querySelector: (selector) => (selector.startsWith('#')
      ? getElementById(selector.slice(1))
      : body.querySelector(selector)),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };

  globalThis.document = document;
  globalThis.DOMParser = ShimDOMParser;

  for (const id of ids) getElementById(id);

  return {
    document,
    byId: getElementById,
    body,
    all: () => [...registry.values()],
  };
}
