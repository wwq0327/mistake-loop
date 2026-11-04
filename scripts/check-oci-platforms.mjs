// #29 辅助：校验多架构构建产物（OCI layout）里两种架构都在。
// 用法：node scripts/check-oci-platforms.mjs <oci-layout.tar>
// 零依赖：只用 tar 解包 + 读 JSON；不改仓库任何文件。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const DEFAULT_PLATFORMS = ['linux/amd64', 'linux/arm64'];

export function readOciPlatforms(tarPath) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-oci-'));
  try {
    execFileSync('tar', ['-xf', tarPath, '-C', dir], { stdio: 'ignore' });
    const blobs = join(dir, 'blobs', 'sha256');
    const platforms = new Set();
    const seen = new Set();

    // index.json 可能一层套一层（多平台导出常带嵌套 index），逐层往下走。
    const walk = (index) => {
      for (const m of index?.manifests ?? []) {
        const os = m.platform?.os;
        const arch = m.platform?.architecture;
        // buildx 的 attestation manifest 平台写作 unknown/unknown，不算一种架构。
        if (os && arch && os !== 'unknown' && arch !== 'unknown') {
          platforms.add(`${os}/${arch}`);
        }
        const digest = String(m.digest ?? '');
        if (!digest.startsWith('sha256:') || seen.has(digest)) continue;
        seen.add(digest);
        const file = join(blobs, digest.slice('sha256:'.length));
        if (!existsSync(file)) continue;
        try {
          walk(JSON.parse(readFileSync(file, 'utf8')));
        } catch {
          // 不是 index（是 image manifest），不用往下走。
        }
      }
    };

    const indexPath = join(dir, 'index.json');
    if (!existsSync(indexPath)) throw new Error('OCI layout 缺 index.json');
    walk(JSON.parse(readFileSync(indexPath, 'utf8')));
    return [...platforms].sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkOciPlatforms(tarPath, expected = DEFAULT_PLATFORMS) {
  let found;
  try {
    found = readOciPlatforms(tarPath);
  } catch (e) {
    return { ok: false, found: [], missing: expected, errors: [`读 OCI 产物失败：${e.message}`] };
  }
  const missing = expected.filter((p) => !found.includes(p));
  return {
    ok: missing.length === 0,
    found,
    missing,
    errors: missing.map((p) => `多架构产物缺 ${p}（实际有 ${found.join('、') || '一个都没有'}）`),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const tarPath = process.argv[2];
  if (!tarPath) {
    console.error('用法：node scripts/check-oci-platforms.mjs <oci-layout.tar>');
    process.exitCode = 1;
  } else {
    const out = checkOciPlatforms(tarPath);
    if (out.ok) console.log(`oci-platforms: PASS (${out.found.join('、')})`);
    else {
      console.error(`oci-platforms: FAIL (实际有 ${out.found.join('、') || '一个都没有'})`);
      for (const e of out.errors) console.error(`  - ${e}`);
      process.exitCode = 1;
    }
  }
}
