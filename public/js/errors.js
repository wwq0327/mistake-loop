// 异步动作的兜底。
//
// 问题：事件回调（onClick、change）里 await 失败时，返回的 promise 没人接，
// 于是变成 unhandled rejection——界面一点动静都没有，老师只看到「点了没反应」。
// 这在题库筛选、收件箱切换照片上都真实发生过（#58）。
//
// 用法：把回调包一层，失败就把话说出来。
//   control.addEventListener('change', guard(render, { notify }));
import { toast } from './ui.js';
import { describeError } from './api.js';

export function guard(fn, { notify = toast } = {}) {
  const report = (error) => {
    notify(describeError(error), 'error');
  };
  return (...args) => {
    try {
      const result = fn(...args);
      // 只有 promise 才接；同步抛错上面已经接住了。
      if (result && typeof result.catch === 'function') return result.catch(report);
      return result;
    } catch (error) {
      report(error);
      return undefined;
    }
  };
}
