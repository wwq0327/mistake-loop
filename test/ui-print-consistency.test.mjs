// #60 测试先行：打印页的计数与预览必须永远对得上，预览过期就不能印。
//
// 红灯预期：现在 refreshSheet() 先改计数、后取数据，
// 取数失败时计数已经是新的、预览还是旧的——两者对不上，
// 而「打印 / 另存 PDF」按钮照样可点，印出来的是旧题。
//
// 要锁住的四条：
//   1. 计数 === 当前预览里的卡片数（成功、失败都得成立）。
//   2. 刷新失败 → 预览标为过期，打印按钮禁用并说明为什么。
//   3. 预览与当前选中不一致时，点打印不印。
//   4. 刷新成功后恢复正常，按钮可用、点了就印。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';

function card(id) {
  return { id, subject: 'math', prompt: `第 ${id} 题的题干`, variants: [] };
}

async function setupPrint({ failPrint = false } = {}) {
  const dom = installDom();
  for (const id of [
    'print-candidates', 'print-preview-body', 'print-selected-count',
    'print-actions', 'print-preview-title', 'print-q', 'toast-host',
  ]) {
    dom.body.append(dom.byId(id));
  }

  const { mount: mountPrint } = await import('../public/js/pages/print.js');

  const messages = [];
  const state = { failPrint };
  const api = async (path) => {
    if (path === '/api/reviews/today') return { items: [{ id: 1 }, { id: 2 }] };
    if (path === '/api/mistakes') {
      return {
        items: [
          { id: 1, subject: 'math', status: 'reviewing', prompt: '一题' },
          { id: 2, subject: 'math', status: 'reviewing', prompt: '二题' },
          { id: 3, subject: 'math', status: 'new', prompt: '三题' },
        ],
      };
    }
    if (path.startsWith('/api/print')) {
      if (state.failPrint) throw new Error('连不上服务');
      const ids = path.split('ids=')[1].split(',').map(Number);
      const cards = ids.map(card);
      return { mode: 'student', total: cards.length, cards };
    }
    throw new Error(`不该调这个接口：${path}`);
  };

  let printed = 0;
  const originalWindow = globalThis.window;
  globalThis.window = { print: () => { printed += 1; } };

  const root = dom.byId('view');
  await mountPrint({ root, api, toast: (message, kind) => messages.push({ message, kind }) });

  return {
    dom,
    root,
    state,
    messages,
    get printed() { return printed; },
    restore() { globalThis.window = originalWindow; },
  };
}

function printButton(dom) {
  return dom.byId('print-actions').descendants().find(
    (n) => n.localName === 'button' && String(n.textContent).includes('打印'),
  );
}

function checkboxes(dom) {
  // 页面用 input[type="checkbox"] 取勾选框，但垫片里 type 是属性不是特性，
  // 直接按 localName + type 找更稳。
  return dom.byId('print-candidates').descendants()
    .filter((n) => n.localName === 'input' && n.type === 'checkbox');
}

function previewCards(dom) {
  return dom.byId('print-preview-body').querySelectorAll('.qcard');
}

function countNumber(dom) {
  const raw = String(dom.byId('print-selected-count').textContent);
  const m = /\d+/.exec(raw);
  return m ? Number(m[0]) : NaN;
}

async function settle(node) {
  const results = node.dispatch('change', {});
  await Promise.all(results.map((r) => (r && typeof r.catch === 'function' ? r.catch(() => {}) : r)));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('#60 刷新成功后，计数与预览里的卡片数一致', async () => {
  const { dom, restore } = await setupPrint();
  try {
    assert.equal(previewCards(dom).length, 2, '默认应带今日复习的两题');
    assert.equal(countNumber(dom), 2, '计数应等于预览卡片数');
    assert.equal(printButton(dom).disabled, false, '预览是新的，打印按钮不该禁用');
  } finally {
    restore();
  }
});

test('#60 刷新失败后，计数与预览不再对不上', async () => {
  const { dom, state, restore } = await setupPrint();
  try {
    // 先正常挂载：预览 2 张卡片，计数 2。
    assert.equal(countNumber(dom), 2);

    // 服务坏了，再勾一道题 → 刷新失败。
    state.failPrint = true;
    const boxes = checkboxes(dom);
    const third = boxes[2];
    third.checked = true;
    await settle(third);

    const cards = previewCards(dom).length;
    assert.equal(
      countNumber(dom),
      cards,
      `计数与预览对不上：计数 ${countNumber(dom)}，预览 ${cards} 张卡片`,
    );
  } finally {
    restore();
  }
});

test('#60 预览过期时打印按钮禁用，并说明为什么不能印', async () => {
  const { dom, state, restore } = await setupPrint();
  try {
    state.failPrint = true;
    const boxes = checkboxes(dom);
    const third = boxes[2];
    third.checked = true;
    await settle(third);

    const button = printButton(dom);
    assert.equal(button.disabled, true, '预览过期时打印按钮必须禁用');

    // 说明要出现在三个地方：预览标题、按钮旁边、预览区里的横幅。
    // 少一处，老师就可能只看到其中一处而没察觉问题。
    const title = textOf(dom.byId('print-preview-title'));
    const actions = textOf(dom.byId('print-actions'));
    const preview = textOf(dom.byId('print-preview-body'));
    assert.match(title, /未更新/, `预览标题要标出未更新：${title}`);
    assert.match(actions, /预览/, `按钮旁边要说明为什么不能印：${actions}`);
    assert.match(preview, /预览没更新成功/, `预览区要有一条横幅说清情况：${preview}`);
    assert.match(preview, /还是上一次的/, `横幅要说清下面印的是哪一份：${preview}`);
  } finally {
    restore();
  }
});

test('#60 预览与当前选题对不上时，点打印不印', async () => {
  // printed 是 getter：解构会拿到当时的值（0），必须整体持有 ctx 再读。
  const ctx = await setupPrint();
  const { dom, state, restore } = ctx;
  try {
    state.failPrint = true;
    const third = checkboxes(dom)[2];
    third.checked = true;
    await settle(third);

    // 按钮已被禁用，但就算绕过 disabled 直接调回调，也不能印。
    const button = printButton(dom);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ctx.printed, 0, '预览过期时点了打印还是印了——印出来的是旧题');

    // 直接调页面的打印回调（模拟绕过按钮禁用），同样必须被拦下。
    printButton(dom).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ctx.printed, 0, '绕过按钮直接触发打印回调，也必须被拦下');
  } finally {
    restore();
  }
});

test('#60 刷新恢复正常后，按钮可用、点了就印', async () => {
  const ctx = await setupPrint();
  const { dom, state, restore } = ctx;
  try {
    state.failPrint = true;
    const third = checkboxes(dom)[2];
    third.checked = true;
    await settle(third);
    assert.equal(printButton(dom).disabled, true);

    // 服务恢复，再触发一次刷新（取消勾选再勾上）。
    state.failPrint = false;
    const boxes = checkboxes(dom);
    boxes[2].checked = false;
    await settle(boxes[2]);
    boxes[2].checked = true;
    await settle(boxes[2]);

    assert.equal(printButton(dom).disabled, false, '预览刷新成功后打印按钮该恢复可用');
    assert.equal(countNumber(dom), previewCards(dom).length, '计数与预览该重新对上');

    printButton(dom).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ctx.printed, 1, '预览是新的，点打印就该真的印');
  } finally {
    restore();
  }
});
