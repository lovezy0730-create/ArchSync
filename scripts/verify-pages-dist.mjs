#!/usr/bin/env node
/**
 * Pages artifact verifier — runs in CI right after `pnpm build:pages`.
 * Fails loudly when the bundle is not shippable:
 *  1. index.html exists and references only /ArchSync/-prefixed assets
 *  2. data/index.json manifest exists with at least one published project
 *  3. every snapshot JSON has the static payload shape and schema basics
 *  4. NO server endpoints (/api, /ws) are referenced anywhere in the bundle
 *  5. NO credential-shaped strings (tokens, access codes, private keys)
 *  6. prints a size summary for the CI log
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'apps', 'web', 'dist');
const BASE = '/ArchSync/';
const problems = [];
const warn = (msg) => console.error(`  ✗ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

console.log('验证 Pages 构建产物:', dist);

/* 1. index.html + asset references */
const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
const refs = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const assetRefs = refs.filter((r) => r.endsWith('.js') || r.endsWith('.css'));
if (assetRefs.length === 0) problems.push('index.html 未引用任何 JS/CSS 资源');
for (const ref of assetRefs) {
  if (!ref.startsWith(BASE)) problems.push(`资源引用未使用 Pages 子路径: ${ref}`);
}
if (assetRefs.every((r) => r.startsWith(BASE))) ok(`资源引用带 ${BASE} 前缀 (${assetRefs.length} 个)`);

/* 2. manifest */
const dataDir = join(dist, 'data');
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dataDir, 'index.json'), 'utf8'));
} catch (err) {
  problems.push(`data/index.json 缺失或非法: ${err.message}`);
}
if (manifest) {
  if (manifest.generator !== 'archsync-static-snapshot') {
    problems.push(`清单 generator 字段异常: ${manifest.generator}`);
  } else {
    ok(`清单有效：${manifest.projects.length} 个已发布项目`);
  }
  if (manifest.projects.length === 0) {
    warn('清单为空 —— 未有任何项目设置 publishStatic: true（演示站点需要至少一个项目）');
    problems.push('清单为空：发布站点必须至少包含一个 publishStatic 项目');
  }
}

/* 3. snapshot payloads */
if (manifest) {
  for (const project of manifest.projects) {
    const text = readFileSync(join(dataDir, project.file), 'utf8');
    const payload = JSON.parse(text);
    const snap = payload.snapshot;
    if (payload.kind !== 'archsync-static-snapshot') problems.push(`${project.file}: kind 字段缺失`);
    if (!Array.isArray(snap?.modules) || snap.modules.length === 0) problems.push(`${project.file}: modules 为空`);
    if (typeof snap?.contentHash !== 'string' || snap.contentHash.length < 8) {
      problems.push(`${project.file}: contentHash 缺失`);
    }
    if (snap?.githubSource === 'live' && snap?.githubDemo === false && manifest.sourceCommitSha) {
      console.log(`  ℹ ${project.file}: 包含真实 GitHub 协作数据（publishPublicGithubData 已开启）`);
    }
    ok(`${project.file}: v${project.version} hash=${project.contentHash}`);
  }
}

/* 4 + 5. bundle content safety */
const SECRET_PATTERNS = [
  ['GitHub PAT', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['github_pat token', /github_pat_[A-Za-z0-9_]{20,}/],
  ['access code env', /AUTH_CODE=/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const ENDPOINT_PATTERNS = [
  ['API 请求', /["'`]\/api\//],
  ['WS 路径', /["'`]\/ws[\?"'`]/],
  ['WS URL', /ws(s)?:\/\//],
];

let jsBytes = 0;
let cssBytes = 0;
for (const file of walk(dist)) {
  const rel = file.slice(dist.length + 1).replace(/\\/g, '/');
  if (!/\.(js|css|html|json)$/.test(rel)) continue;
  const text = readFileSync(file, 'utf8');
  const size = statSync(file).size;
  if (rel.endsWith('.js')) jsBytes += size;
  if (rel.endsWith('.css')) cssBytes += size;

  if (!rel.startsWith('data/') || rel.endsWith('index.json') || rel.endsWith('.js') || rel.endsWith('.html')) {
    for (const [name, pattern] of ENDPOINT_PATTERNS) {
      if (pattern.test(text)) problems.push(`${rel}: 静态包中包含 ${name} 引用（静态模式不得请求 /api 或 /ws）`);
    }
  }
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) problems.push(`${rel}: 检测到疑似 ${name}`);
  }
}

if (jsBytes > 0) ok(`无 /api、/ws 引用，无凭据泄漏（JS ${Math.round(jsBytes / 1024)} KB, CSS ${Math.round(cssBytes / 1024)} KB）`);

/* summary */
const totalBytes = walk(dist).reduce((sum, f) => sum + statSync(f).size, 0);
console.log(`\n产物总大小: ${Math.round(totalBytes / 1024)} KB，文件数: ${walk(dist).length}`);
console.log(`构建版本: ${manifest?.generatedAt ?? 'unknown'} / commit ${manifest?.sourceCommitSha?.slice(0, 8) ?? 'unknown'}`);

if (problems.length > 0) {
  console.error(`\n验证失败，${problems.length} 个问题:`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('\nPages 产物验证通过 ✓（GitHub Pages Ready — Not Deployed）');
