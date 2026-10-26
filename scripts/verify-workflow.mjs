#!/usr/bin/env node
/**
 * Workflow structure gate — the actionlint-equivalent checks we can make
 * without external tooling, focused on the release pipeline's guarantees:
 *   build(readonly) → archive(write) → deploy(pages), PR-safe.
 * Fails loudly when any release guarantee is missing. Run in CI before the
 * pipeline is trusted (wired into `pnpm verify:workflow`).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, '.github', 'workflows', 'pages-build.yml');
const text = readFileSync(file, 'utf8');

// Minimal YAML subset parser: this workflow uses plain mappings, sequences and
// scalars — good enough for structural assertions without a YAML dependency.
// (Full YAML parse exists in dev via the `yaml` package; we avoid importing
// workspace deps here so the check can run anywhere.)
const problems = [];
// code lines only: comments must not trip permission/trigger assertions
const code = text
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');
const has = (needle, label) => {
  if (!code.includes(needle)) problems.push(`缺少 ${label}`);
};
const notHas = (needle, label) => {
  if (code.includes(needle)) problems.push(`不应出现 ${label}`);
};

/* three jobs exist */
for (const job of ['build:', 'archive:', 'deploy:']) {
  if (!new RegExp(`^  ${job}$`, 'm').test(text)) problems.push(`缺少 job: ${job}`);
}

/* permission boundaries */
const buildSection = code.slice(code.indexOf('  build:'), code.indexOf('  archive:'));
const archiveSection = code.slice(code.indexOf('  archive:'), code.indexOf('  deploy:'));
const deploySection = code.slice(code.indexOf('  deploy:'));

if (!/permissions:\s*\n\s*contents: read/.test(buildSection)) {
  problems.push('build job 必须只有 contents: read');
}
if (!/contents: write/.test(archiveSection)) {
  problems.push('archive job 必须拥有 contents: write');
}
if (/contents: write/.test(buildSection)) {
  problems.push('build job 不得拥有写权限');
}
for (const perm of ['pages: write', 'id-token: write']) {
  if (!deploySection.includes(perm)) problems.push(`deploy job 缺少 ${perm}`);
}

/* script actually exists in the audited tree */
const fs = await import('node:fs');
{
  if (!fs.existsSync(join(root, 'scripts', 'archive-history.sh'))) {
    problems.push('scripts/archive-history.sh 不存在（archive job 将无法执行）');
  }

  /* archive checks out trusted main before running the script */
  const archiveHasCheckout = /actions\/checkout@v\d/.test(archiveSection);
  if (!archiveHasCheckout) {
    problems.push('archive job 必须显式 checkout 才能获得归档脚本');
  }

  /* Protect the precise history layout emitted by generate-static-snapshot.ts:
     site-snapshots/<projectId>/{index.json,vN.json}. Using
     site-snapshots/history uploads zero files on the first production run. */
  if (!/name:\\s*snapshot-history\\s*\\n\\s*path:\\s*site-snapshots\\/\\s*(?:\\n|$)/m.test(buildSection)) {
    problems.push('snapshot-history artifact 必须上传 site-snapshots/ 根目录（包含 projectId 子目录），不能使用 site-snapshots/history');
  }
  if (!/name:\\s*snapshot-history\\s*\\n\\s*path:\\s*incoming-history(?:\\s|$)/m.test(archiveSection)) {
    problems.push('archive 必须将 snapshot-history 下载到 incoming-history');
  }

  /* official pages artifact + dependency chain */
  if (!text.includes('actions/upload-pages-artifact@v3')) {
    problems.push('缺少官方 actions/upload-pages-artifact（deploy-pages 依赖 github-pages artifact）');
  }
  if (!text.includes('actions/deploy-pages@v4')) problems.push('缺少 actions/deploy-pages@v4');
  if (!/needs:\s*\[build,\s*archive\]/.test(deploySection)) {
    problems.push('deploy 必须 needs: [build, archive]');
  }
  if (!archiveSection.includes('needs: build')) problems.push('archive 必须 needs: build');

  /* PR safety: archive/deploy skip on pull_request; no pull_request_target */
  if (!archiveSection.includes("github.event_name != 'pull_request'")) {
    problems.push('archive 必须在 PR 事件跳过');
  }
  if (!deploySection.includes("github.event_name != 'pull_request'")) {
    problems.push('deploy 必须在 PR 事件跳过');
  }
  notHas('pull_request_target', '不安全的 pull_request_target 触发器');

  /* no token leakage into logs or artifacts */
  if (/set -x/.test(archiveSection)) problems.push('archive 禁止 set -x（会打印含 Token 的命令）');
  if (/echo .*\$\{?GH_TOKEN/.test(archiveSection)) problems.push('archive 不得 echo Token');

  if (problems.length > 0) {
    console.error(`工作流结构检查失败（${problems.length} 项）：`);
    for (const p of problems) console.error(` - ${p}`);
    process.exit(1);
  }
  console.log('工作流结构检查通过 ✓（build 只读 → archive 写 → deploy 发布；PR 安全）');
}
