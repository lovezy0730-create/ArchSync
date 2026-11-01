import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Deterministic 1000-file TypeScript fixture shared by the scan and watcher
 * benchmarks. The hash is part of the frozen report identity: change the
 * generator only together with `datasetVersion`.
 */
export const FIXTURE_VERSION = "rc5-ts-1000-v1";

export function generateTsFixture(count = 1000) {
  const files = Array.from({ length: count }, (_, i) => {
    const folder = `pkg${Math.floor(i / 100)}`;
    const previous = i ? `import { fn${i - 1} } from '../pkg${Math.floor((i - 1) / 100)}/f${i - 1}';\n` : "";
    const call = i ? `fn${i - 1}(n) + ` : "";
    return {
      path: `src/${folder}/f${i}.ts`,
      source: `${previous}export interface Data${i} { value: number }\nexport class Service${i} { run(n: number): number { return n + ${i}; } }\nexport function fn${i}(n: number): number { return ${call}${i}; }\n`,
    };
  });
  const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { version: FIXTURE_VERSION, files, hash };
}

export function writeFixture(root: string, files: { path: string; source: string }[]): void {
  for (const file of files) {
    const destination = join(root, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.source);
  }
}
