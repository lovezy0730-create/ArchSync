import { PythonScanner } from "@archsync/scanner/python";
import { FileUpdateSchema, CodeIndex } from "./code-index.js";
const scanners = new WeakMap<CodeIndex, PythonScanner>();
export async function scanPythonIndex(
  root: string,
  projectId: string,
  index: CodeIndex,
  renames: Record<string, string> = {},
  moduleFor?: (path: string) => string,
) {
  let scanner = scanners.get(index);
  if (!scanner) {
    scanner = new PythonScanner();
    scanners.set(index, scanner);
  }
  const start = performance.now();
  const result = await scanner.scan(root, projectId);
  const parsedAt = performance.now();
  const updates = result.updates.map((u) => {
    const moduleId = moduleFor?.(u.filePath) ?? u.moduleId;
    return FileUpdateSchema.parse({ ...u, moduleId, symbols: u.symbols.map((s) => ({ ...s, moduleId })) });
  });
  for (const f of index.files(projectId))
    if (
      f.language === "python" &&
      !updates.some((u) => u.filePath === f.filePath)
    )
      updates.push({
        ...f,
        status: "deleted",
        symbols: [],
        relations: [],
        contentHash: null,
      });
  index.applyBatch(projectId, updates, renames);
  return {
    files: result.updates.length,
    symbols: updates.flatMap((f) => f.symbols),
    relations: updates.flatMap((f) => f.relations),
    diagnostics: updates.flatMap((f) => f.diagnostics),
    routes: updates
      .flatMap((f) => f.relations)
      .filter((r) => r.kind === "routes_to").length,
    parseMs: result.parseMs,
    analysisMs: parsedAt - start,
    commitMs: performance.now() - parsedAt,
    totalMs: performance.now() - start,
    cachedFiles: result.cachedFiles,
  };
}

export function releasePythonIndex(index: CodeIndex): void {
  scanners.get(index)?.dispose();
  scanners.delete(index);
}
