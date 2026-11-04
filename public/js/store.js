// 页面间共享的最小状态。不做全局状态容器，不缓存学生答案。
const state = {
  currentMistakeId: null,
  pendingDrafts: 0,
  aiEnabled: false,
};

const listeners = new Set();

export function getState() {
  return { ...state };
}

export function setState(patch) {
  Object.assign(state, patch);
  const snapshot = getState();
  for (const listener of listeners) listener(snapshot);
  return snapshot;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function mistakeIdFromLocation() {
  const match = location.pathname.match(/^\/mistake\/(\d+)/);
  if (match) return Number(match[1]);
  return Number(new URLSearchParams(location.search).get('id')) || null;
}
