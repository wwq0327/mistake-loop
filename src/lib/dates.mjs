// 日期一律按 Asia/Shanghai 计算，不依赖进程 TZ（NAS 常被设成 UTC）。
export const TIME_ZONE = 'Asia/Shanghai';

function shanghaiParts(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')) % 24, minute: Number(get('minute')), second: Number(get('second')),
  };
}

export function today(now = new Date()) {
  const p = shanghaiParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) throw new Error(`invalid date: ${dateStr}`);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(fromDate, toDate) {
  const toMs = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(toDate) - toMs(fromDate)) / 86400000);
}

// 到下一个本地 00:05 的毫秒数。中国无夏令时，固定 UTC+8 即可。
export function nextRunDelay(now = new Date()) {
  const p = shanghaiParts(now);
  let minutes = 5 - (p.hour * 60 + p.minute);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes * 60000 - p.second * 1000 - now.getMilliseconds();
}
