import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve("."),
  req = createRequire(join(root, "packages/scanner/package.json")),
  buildRequire = createRequire(join(root, "apps/desktop/package.json"));
const dir = mkdtempSync(join(tmpdir(), "archsync 离线资源 "));
const assets = join(dir, "assets");
mkdirSync(assets);
mkdirSync(join(dir, "source"));
const resources = {
  "tree-sitter.cjs": req.resolve("web-tree-sitter"),
  "tree-sitter.wasm": req.resolve("web-tree-sitter/tree-sitter.wasm"),
  "tree-sitter-python.wasm": req.resolve(
    "tree-sitter-wasms/out/tree-sitter-python.wasm",
  ),
};
try {
  for (const [name, path] of Object.entries(resources))
    copyFileSync(path, join(assets, name));
  writeFileSync(
    join(dir, "source", "中文.py"),
    "class Service:\n    def value(self, n: int = 1) -> int:\n        return n + 2\n",
  );
  const entry = join(dir, "probe.ts");
  writeFileSync(
    entry,
    `import {LocalDatabase} from ${JSON.stringify(join(root, "apps/server/src/db.ts"))};import {CodeIndex} from ${JSON.stringify(join(root, "apps/server/src/code-index.ts"))};import {scanPythonIndex} from ${JSON.stringify(join(root, "apps/server/src/python-index.ts"))};import assert from 'node:assert/strict';globalThis.fetch=async()=>{throw new Error('network forbidden')};(async()=>{const db=new LocalDatabase(':memory:');try{const index=new CodeIndex(db);const result=await scanPythonIndex(${JSON.stringify(join(dir, "source"))},'offline',index);assert.equal(result.files,1);assert.equal(result.symbols.filter(s=>s.kind==='method').length,1);assert.equal(index.get('offline','中文.py')?.status,'fresh');console.log(JSON.stringify({pass:true,platform:process.platform,node:process.version,electron:process.versions.electron??null,files:result.files,symbols:result.symbols.length,network:'fetch forbidden',resources:'isolated copied local WASM; no node_modules or Python'}));}finally{db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});`,
  );
  await buildRequire("esbuild").build({
    entryPoints: [entry],
    outfile: join(dir, "probe.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    define: { "import.meta.url": "__url" },
    banner: {
      js: 'const __url = require("node:url").pathToFileURL(__filename).href;',
    },
    logLevel: "silent",
  });
  const exe = process.argv.includes("--electron")
    ? (process.env.ARCHSYNC_ELECTRON_EXE ?? buildRequire("electron"))
    : process.execPath;
  const run = spawnSync(exe, [join(dir, "probe.cjs")], {
    env: {
      ...process.env,
      ARCHSYNC_PYTHON_ASSETS: assets,
      PATH: "",
      ...(process.argv.includes("--electron")
        ? { ELECTRON_RUN_AS_NODE: "1" }
        : {}),
    },
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(run.stderr || String(run.error));
  const proof = {
    ...JSON.parse(run.stdout.trim()),
    assetHashes: Object.fromEntries(
      Object.keys(resources).map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(assets, name)))
          .digest("hex"),
      ]),
    ),
  };
  console.log(JSON.stringify(proof, null, 2));
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (process.argv.includes("--out") && out)
    writeFileSync(out, JSON.stringify(proof, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
}
