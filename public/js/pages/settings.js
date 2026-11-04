// 设置：AI 状态、教材版本、备份与健康。开关与备份动作在 #24 接入。
import { el, card, alert, stateTag } from '../ui.js';

export async function mount({ root, api, state }) {
  const health = await api('/health');
  const meta = await api('/api/meta');

  const ai = card('AI 图片识别', { actions: [stateTag(state.aiEnabled ? 'mastered' : 'new', state.aiEnabled ? '已开启' : '默认关闭')] });
  ai.body.append(
    alert(state.aiEnabled
      ? '照片会离开这台设备发往云端识别服务，只发送压缩图；识别结果只进草稿，需逐题确认。'
      : '当前不联网、不配密钥，纯手工录入路径完全等价。开启后题目照片会离开局域网。', state.aiEnabled ? 'warn' : 'info'),
    el('p', 'small muted', '开关、今日用量与最近失败原因将在设置页接入后显示。'),
  );

  const data = card('数据与教材');
  const rows = el('div', 'stack');
  rows.append(
    el('p', 'small', `教材版本：${meta.editions ? JSON.stringify(meta.editions) : '按旧库骨架（四上三科）'}`),
    el('p', 'small', `题库总数：${meta.stats.total} 道，已审核变式 ${meta.stats.variantsReviewed} 条`),
    el('p', 'small', `备份命令：npm run backup（快照落在 data/backups/，不入库）`),
  );
  data.body.append(rows);

  const service = card('服务健康', { actions: [stateTag(health.ok ? 'mastered' : 'new', health.ok ? '正常' : '异常')] });
  service.body.append(
    el('p', 'small', `数据库：${health.db}`),
    el('p', 'small', `调度：${health.scheduler?.running ? '运行中' : '未运行'}，上次结果 ${JSON.stringify(health.scheduler?.lastResult ?? null)}`),
  );

  root.replaceChildren(ai, data, service);
}
