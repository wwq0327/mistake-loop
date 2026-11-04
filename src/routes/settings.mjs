// 设置页后端：AI 进程内开关、一键备份与恢复演练。
// 密钥永远只来自启动服务的环境变量，本路由不接收、不回显、不落日志。
import { Router } from 'express';
import { basename, join } from 'node:path';
import { HttpError, assert } from '../lib/validation.mjs';
import { backup, restore } from '../../scripts/backup.mjs';

function takeSnapshot(dataDir) {
  const result = backup({ dataDir, outputDir: join(dataDir, 'backups') });
  const drill = restore({ backupDir: result.target });
  return {
    ok: drill.ok && drill.mismatches.length === 0,
    // 只回目录名，不把本机绝对路径带到接口响应里。
    target: basename(result.target),
    database: result.manifest.database,
    images: result.manifest.images,
    restore: {
      ok: drill.ok,
      mismatches: drill.mismatches,
      // 恢复演练的图片核对口径（#43）：备份里的照片齐不齐，界面要看得见。
      images: {
        expected: drill.images.expected,
        actual: drill.images.actual,
        missing: drill.images.missing,
        mismatches: drill.images.mismatches,
      },
    },
    createdAt: result.manifest.created_at,
  };
}

export function createSettingsRouter({ dataDir, aiControl = null, backupRunner = null }) {
  const router = Router();

  // 只在服务端已完整配置 AI 时允许切换；没配置就拒绝，绝不在这里造出密钥。
  router.post('/ai/toggle', (req, res) => {
    const enabled = req.body?.enabled;
    assert(typeof enabled === 'boolean', 'enabled 必须是 true 或 false', 'INVALID_ENABLED');
    if (!aiControl || aiControl.configured !== true) {
      throw new HttpError(
        409,
        'AI_NOT_CONFIGURED',
        '未配置 AI 服务商，不能在这里开启；请先在启动服务的环境变量里配置并重启',
      );
    }
    aiControl.enabled = enabled;
    res.json({ enabled: aiControl.enabled, configured: true });
  });

  router.post('/backup', (req, res) => {
    res.json(backupRunner ? backupRunner() : takeSnapshot(dataDir));
  });

  return router;
}
