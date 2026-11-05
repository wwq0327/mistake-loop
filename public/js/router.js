// 轻量路由：按 body[data-page] 挂载页面模块，无第三方库、无 history 劫持。
import { mount as workbench } from './pages/workbench.js';
import { mount as inbox } from './pages/inbox.js';
import { mount as detail } from './pages/detail.js';
import { mount as print } from './pages/print.js';
import { mount as library } from './pages/library.js';
import { mount as settings } from './pages/settings.js';
import { getState, setState } from './store.js';
import { api } from './api.js';
import { alert, toast } from './ui.js';

const MODULES = { workbench, inbox, detail, print, library, settings };
const NAV_TARGETS = ['/', '/inbox', '/print', '/library', '/settings'];

function currentNavPath() {
  const path = location.pathname;
  // 详情页归属工作台（#65）：从看板点进来的，导航上亮着的是工作台，不是题库。
  if (path.startsWith('/mistake/')) return '/';
  if (NAV_TARGETS.includes(path)) return path;
  if (path === '/index.html') return '/';
  return '/';
}

function markNavigation() {
  const target = currentNavPath();
  for (const node of document.querySelectorAll('.nav-link, .tab-link')) {
    if (node.getAttribute('href') === target) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
}

// 六页共用的页内过滤：只隐藏不匹配的条目，不改数据、不发请求。
function bindPageFilter() {
  const input = document.getElementById('page-q');
  const view = document.getElementById('view');
  if (!input || !view) return;
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    for (const node of view.querySelectorAll('.row, .qcard, .card__body > p')) {
      node.style.display = !query || node.textContent.toLowerCase().includes(query) ? '' : 'none';
    }
  });
}

async function refreshAiStatus() {
  try {
    const status = await api('/api/ai/status');
    setState({ aiEnabled: Boolean(status.enabled), pendingDrafts: Number(status.pendingDrafts || 0) });
  } catch {
    // P3 之前该接口尚未上线，保持默认关闭，不弹错。
    setState({ aiEnabled: false });
  }
}

async function boot() {
  markNavigation();
  bindPageFilter();
  const page = document.body.dataset.page;
  const root = document.getElementById('view');
  const mount = MODULES[page];
  if (!root || !mount) return;
  await refreshAiStatus();
  try {
    await mount({ root, state: getState(), api, toast, alert });
  } catch (error) {
    root.replaceChildren(alert(error?.message || '页面加载失败', 'error'));
  }
}

boot();
