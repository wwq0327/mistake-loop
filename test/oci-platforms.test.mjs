// #29 测试先行：多架构构建产物的自检脚本。
// 红灯预期：scripts/check-oci-platforms.mjs 还不存在。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOciPlatforms } from '../scripts/check-oci-platforms.mjs';

// 造一个 OCI layout：index.json → 嵌套 index → 两个带平台信息的 manifest。
function makeOciTar(platforms) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-oci-make-'));
  mkdirSync(join(dir, 'blobs', 'sha256'), { recursive: true });
  const manifests = platforms.map((p, i) => {
    const digest = `sha256:${String(i).repeat(64)}`;
    writeFileSync(join(dir, 'blobs', 'sha256', digest.slice(7)), JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest, size: 1 }],
    }));
    return { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest, size: 1 };
  });
  writeFileSync(join(dir, 'index.json'), JSON.stringify({
    schemaVersion: 2,
    manifests: [{
      mediaType: 'application/vnd.oci.image.index.v1+json',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 1,
      platform: { architecture: 'amd64', os: 'linux' },
    }],
  }));
  writeFileSync(join(dir, 'blobs', 'sha256', 'a'.repeat(64)), JSON.stringify({
    schemaVersion: 2,
    manifests: manifests.map((m, i) => ({
      ...m,
      platform: { architecture: platforms[i].split('/')[1], os: platforms[i].split('/')[0] },
    })),
  }));
  const tarPath = join(dir, 'out.tar');
  execFileSync('tar', ['-cf', tarPath, '-C', dir, 'index.json', 'blobs'], { stdio: 'ignore' });
  return { dir, tarPath };
}

test('#29 OCI 产物里两种架构都在时判通过', () => {
  const { dir, tarPath } = makeOciTar(['linux/amd64', 'linux/arm64']);
  try {
    const out = checkOciPlatforms(tarPath);
    assert.equal(out.ok, true, out.errors.join('；'));
    assert.deepEqual(out.found, ['linux/amd64', 'linux/arm64']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#29 OCI 产物缺一种架构时判失败，并点名缺哪一种', () => {
  const { dir, tarPath } = makeOciTar(['linux/amd64']);
  try {
    const out = checkOciPlatforms(tarPath);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /linux\/arm64/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#29 产物不是 OCI layout 时判失败，不静默放过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-oci-bad-'));
  try {
    const tarPath = join(dir, 'bad.tar');
    writeFileSync(join(dir, 'a.txt'), 'not an oci layout\n');
    execFileSync('tar', ['-cf', tarPath, '-C', dir, 'a.txt'], { stdio: 'ignore' });
    const out = checkOciPlatforms(tarPath);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /index\.json|失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
