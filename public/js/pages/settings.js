// 设置：AI 状态与显式开关、今日用量、备份、服务健康。
// 页面不出现密钥、端点或模型名；开关只在服务端已配置时可切换。
import { el, alert, toast } from '../ui.js';

// 备份结果要说清三件事：快照里有什么、恢复演练核对了多少张图、演练有没有过。
// 演练的图片口径来自 #43 的恢复核对——照片齐不齐必须看得见，
// 不能只报一个图片总数然后说「通过」。
export function describeBackup(result) {
  const parts = [`快照 ${result.target}：记录数 ${JSON.stringify(result.database)}`];
  const drill = result.restore || {};
  const actual = drill.images?.actual;
  if (actual) {
    parts.push(`图片核对：旧库原图 ${actual.legacy} 张 / 派生图 ${actual.derived} 张 / 新收件原图 ${actual.root} 张 / 被引用 ${actual.referenced} 张 / 孤儿 ${actual.orphan} 张 / 缺文件 ${actual.missing} 张`);
  } else {
    parts.push(`图片 ${result.images ?? 0} 张`);
  }
  if (drill.ok) {
    parts.push('恢复演练：通过');
  } else {
    parts.push('恢复演练未通过');
    for (const line of drill.mismatches || []) parts.push(`差异：${line}`);
  }
  return parts.join(' · ');
}

export async function mount({ root, api, toast: notify = toast }) {
  const toggle = document.getElementById('settings-ai-toggle');
  const configuredLabel = document.getElementById('settings-ai-configured');
  const usage = document.getElementById('settings-ai-usage');
  const errorNode = document.getElementById('settings-ai-error');
  const backupButton = document.getElementById('settings-backup-action');
  const backupResult = document.getElementById('settings-backup-result');
  const healthButton = document.getElementById('settings-health-action');
  const healthResult = document.getElementById('settings-health-result');
  if (!toggle || !configuredLabel || !usage || !errorNode || !backupButton
      || !backupResult || !healthButton || !healthResult) {
    root.replaceChildren(alert('设置页骨架不完整，请刷新页面。', 'error'));
    return;
  }

  let configured = false;

  async function renderAi() {
    const status = await api('/api/ai/status');
    configured = Boolean(status.configured);
    const enabled = Boolean(status.enabled);
    configuredLabel.textContent = configured
      ? (enabled ? '已启用' : '已配置 · 已暂停')
      : '默认关闭 · 未配置';
    toggle.checked = enabled;
    toggle.disabled = !configured;
    usage.textContent = `今日已用 ${status.todayUsed} / 上限 ${status.dailyLimit} · 待确认草稿 ${status.pendingDrafts} 道`;
    errorNode.textContent = `最近失败原因：${status.lastError || '无'}`;
    return status;
  }

  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      const result = await api('/api/ai/toggle', { method: 'POST', body: { enabled: toggle.checked } });
      notify(result.enabled
        ? '已启用：照片将发往你配置的 AI 服务商，识别结果只进草稿。'
        : '已暂停：照片不再外发，收件箱改为手工录入，功能等价可用。');
    } catch (error) {
      notify(`没能切换：${error.message}`, 'error');
    }
    try {
      await renderAi();
    } finally {
      toggle.disabled = !configured;
    }
  });

  backupButton.addEventListener('click', async () => {
    backupButton.disabled = true;
    backupResult.textContent = '正在生成快照并做恢复演练…';
    try {
      const result = await api('/api/backup', { method: 'POST' });
      backupResult.textContent = describeBackup(result);
      notify(result.ok ? '备份完成，恢复演练通过。' : '备份完成但恢复演练未通过，请检查。', result.ok ? 'info' : 'error');
    } catch (error) {
      backupResult.textContent = `备份失败：${error.message}`;
      notify(`备份失败：${error.message}`, 'error');
    } finally {
      backupButton.disabled = false;
    }
  });

  async function renderHealth() {
    const [health, meta] = await Promise.all([api('/health'), api('/api/meta')]);
    healthResult.textContent = `数据库 ${health.db} · 调度 ${health.scheduler?.running ? '运行中' : '未运行'} · 今日 ${meta.today} · 题库 ${meta.stats.total} 道 · 教材 ${Object.values(meta.editions || {}).join(' / ')}`;
  }

  healthButton.addEventListener('click', () => {
    healthButton.disabled = true;
    renderHealth()
      .catch((error) => { healthResult.textContent = `健康检查失败：${error.message}`; })
      .finally(() => { healthButton.disabled = false; });
  });

  root.replaceChildren(alert('AI 默认关闭。未配置时开关不可用；开启后照片会离开这台设备，识别结果只进草稿。', 'info'));
  await Promise.all([renderAi(), renderHealth()]);
}
