import { AstScanner } from "@archsync/scanner/ast";
import { performance } from "node:perf_hooks";
import { CodeIndex, FileUpdateSchema } from "./code-index.js";
const scanners = new WeakMap<CodeIndex, AstScanner>();
export function scanAstIndex(
  root: string,
  projectId: string,
  index: CodeIndex,
  renames: Record<string, string> = {},
  moduleFor?: (path: string) => string,
) {
  let scanner = scanners.get(index);
  if (!scanner) {
    scanner = new AstScanner();
    scanners.set(index, scanner);
  }
  const start = performance.now();
  const result = scanner.scan(root, projectId);
  const parsedAt = performance.now();
  const updates = result.updates.map((u) => {
    const moduleId = moduleFor?.(u.filePath) ?? u.moduleId;
    return FileUpdateSchema.parse({ ...u, moduleId, symbols: u.symbols.map((s) => ({ ...s, moduleId })) });
  });
  const known = index.files(projectId);
  for (const f of known)
    if (
      ["typescript", "javascript"].includes(f.language) &&
      !updates.some((u) => u.filePath === f.filePath)
    )
      updates.push({
        ...f,
        status: "deleted",
        symbols: [],
        relations: [],
        contentHash: null,
        scannedAt: new Date().toISOString(),
      });
  index.applyBatch(projectId, updates, renames);
  const finish = performance.now();
  return {
    files: result.updates.length,
    symbols: updates.reduce((n, f) => n + f.symbols.length, 0),
    relations: updates.flatMap((f) => f.relations),
    diagnostics: updates.flatMap((f) => f.diagnostics),
    parseMs: result.parseMs,
    analysisMs: parsedAt - start,
    commitMs: finish - parsedAt,
    totalMs: finish - start,
    cachedFiles: result.cachedFiles,
  };
}
