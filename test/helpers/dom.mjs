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
    // 父指针：后代组合选择器（'.a .b'）要靠祖先链判断，
    // 真浏览器就是这么匹配的，垫片不能差这一条。
    this.parent = null;
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
    // href 同理：浏览器里 href 是可读属性，赋值后 getAttribute 也要读得到。
    // 早先只是普通赋值，于是 getAttribute('href') 恒为 null——
    // 「这链接到底指向哪」这类断言全都落空。
    Object.defineProperty(this, 'href', {
      get() { return this.getAttribute('href') ?? ''; },
      set(value) { this.setAttribute('href', String(value)); },
      configurable: true,
    });
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof ShimNode) node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) {
      if (node instanceof ShimNode) node.parent = this;
      this.children.push(node);
    }
  }

  // firstChild / lastChild / childElementCount：页面代码会用它们找挂载点，
  // 缺了会在「append of undefined」这种看不出业务含义的地方炸。
  get firstChild() { return this.children[0] ?? null; }

  get lastChild() { return this.children[this.children.length - 1] ?? null; }

  get childElementCount() { return this.children.length; }

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
    // 逗号分组 + 后代组合都要支持：真实浏览器里 '.a .b, .c' 是两组选择器，
    // 早先的垫片按空格切分，逗号被切进选择器里，于是「同时匹配」变成「或」的反面，
    // 查询结果悄悄变空——断言空转通过，看起来是绿的，什么也没测到。
    const out = [];
    for (const group of splitSelectorGroups(selector)) {
      const parts = group.split(/\s+/).filter(Boolean);
      for (const node of this.descendants()) {
        if (matchesChain(node, parts) && !out.includes(node)) out.push(node);
      }
    }
    return out;
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
export function matches(node, selector) {  return selector.split(',').map((s) => s.trim()).filter(Boolean).some((part) => {
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

// 把选择器按顶层逗号分成若干组（方括号里的逗号不算分隔符）。
export function splitSelectorGroups(selector) {
  const groups = [];
  let depth = 0;
  let current = '';
  for (const ch of String(selector)) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      groups.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  groups.push(current);
  return groups.map((group) => group.trim()).filter(Boolean);
}

// 后代组合选择器：'.a .b' 要求节点自己匹配 .b，且祖先里有一个匹配 .a。
// 真浏览器就是这么匹配的；垫片早先把它当成「同一元素满足全部条件」，
// 于是 '.列 .卡' 永远匹配不到——测试因此出现「明明渲染了却说找不到」。
export function matchesChain(node, parts) {
  if (!parts.length) return true;
  // 自己匹配最右一段，再沿祖先链回溯剩下的段。
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  if (!matches(node, last)) return false;
  if (!rest.length) return true;
  let parent = node.parent;
  while (parent) {
    if (matchesChain(parent, rest)) return true;
    parent = parent.parent;
  }
  return false;
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
// location 可配：页面代码从 location.pathname / location.search 取当前题号，
// 不给 location 会让读它的页面直接 ReferenceError（测试报错会指向垫片而不是业务代码，
// 那种报错比红灯难读）。
export function installDom({ ids = [], location: locationOption = null } = {}) {
  const registry = new Map();
  const body = new ShimNode('body');

  // 与 querySelectorAll 走同一套匹配逻辑（逗号分组 + 后代组合）。
  const querySelector = (selector) => {
    for (const group of splitSelectorGroups(selector)) {
      const parts = group.split(/\s+/).filter(Boolean);
      for (const candidate of body.descendants()) {
        if (matchesChain(candidate, parts)) return candidate;
      }
    }
    return null;
  };

  const getElementById = (id) => {
    // 先查文档：树上真有这个 id 就用它，别再另造一个。
    const found = querySelector(`#${id}`);
    if (found) {
      registry.set(id, found);
      return found;
    }
    // 文档里没有，就退回登记过的那一个（可能还没被 append）；
    // 必须每次返回同一个占位节点，否则每次调用都造新的，写进去的东西立刻丢失。
    if (registry.has(id)) return registry.get(id);
    const node = new ShimNode('div');
    node.id = id;
    registry.set(id, node);
    return node;
  };

  const document = {
    body,
    getElementById,
    createElement: (tag) => new ShimNode(tag),
    createElementNS: (ns, tag) => new ShimNode(tag, ns),
    importNode: (node) => cloneNode(node),
    // 支持后代组合选择器（如 '#detail-variants .card__body'）：
    // 页面代码用 bodyOf(id) 找「区块里的内容区」，只认单段选择器会退化成
    // 按整串 id 现造一个空节点——内容渲染进了游离节点，测试自然找不到。
    querySelector,
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };

  globalThis.document = document;
  globalThis.DOMParser = ShimDOMParser;
  // location 默认给个最小可用的：pathname 与 search 都要有，
  // 页面代码会用 new URLSearchParams(location.search) 读查询串。
  globalThis.location = locationOption ?? { pathname: '/', search: '', hash: '', href: '/' };

  for (const id of ids) getElementById(id);

  return {
    document,
    byId: getElementById,
    body,
    all: () => [...registry.values()],
    setLocation: (next) => { globalThis.location = { ...globalThis.location, ...next }; },
  };
}
