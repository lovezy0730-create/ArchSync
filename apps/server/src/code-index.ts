import { z } from "zod";
import {
  SourceFileSchema,
  SymbolDraftSchema,
  RelationDraftSchema,
  RelativeSourcePathSchema,
  IndexStatusSchema,
  ScanDiagnosticSchema,
  type SourceFile,
} from "@archsync/contracts";
import { matchSymbols, symbolKey } from "@archsync/scanner/identity";
import type { LocalDatabase } from "./db.js";
export const FileUpdateSchema = z.object({
  projectId: z.string().min(1),
  moduleId: z.string().min(1),
  filePath: RelativeSourcePathSchema,
  language: z.enum(["typescript", "javascript", "python", "unknown"]),
  contentHash: z.string().nullable(),
  parserVersion: z.string().min(1),
  configVersion: z.string().min(1),
  scannedAt: z.string().datetime(),
  status: IndexStatusSchema,
  diagnostics: z.array(ScanDiagnosticSchema),
  symbols: z.array(SymbolDraftSchema),
  relations: z.array(RelationDraftSchema),
});
export type FileUpdate = z.infer<typeof FileUpdateSchema>;
type Row = { payload_json: string; last_success_json: string | null };
// Scan timestamps and identity explanations do not change indexed facts. Keep
// history compact while still detecting changed relations and parser settings.
function comparableFacts(file: SourceFile): string {
  const volatile = new Set(["scannedAt", "revision", "indexRevision", "identity"]);
  return JSON.stringify(file, (key, value: unknown) =>
    volatile.has(key) ? undefined : value,
  );
}
/** Storage only: callers provide parser outcomes, never execute repository code. */
export class CodeIndex {
  constructor(private readonly db: LocalDatabase) {}
  get(projectId: string, filePath: string): SourceFile | null {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM code_index_files WHERE project_id=? AND file_path=?",
      )
      .get(projectId, filePath) as Row | undefined;
    return row ? SourceFileSchema.parse(JSON.parse(row.payload_json)) : null;
  }
  files(projectId: string): SourceFile[] {
    return (
      this.db
        .prepare("SELECT payload_json FROM code_index_files WHERE project_id=?")
        .all(projectId) as Row[]
    ).map((r) => SourceFileSchema.parse(JSON.parse(r.payload_json)));
  }
  history(projectId: string, filePath: string): SourceFile[] {
    return (
      this.db
        .prepare(
          "SELECT payload_json FROM code_index_history WHERE project_id=? AND file_path=? ORDER BY revision",
        )
        .all(projectId, filePath) as Row[]
    ).map((r) => SourceFileSchema.parse(JSON.parse(r.payload_json)));
  }
  applyBatch(
    projectId: string,
    raw: FileUpdate[],
    renames: Record<string, string> = {},
  ): void {
    const updates = raw.map((u) => FileUpdateSchema.parse(u));
    if (new Set(updates.map((u) => u.filePath)).size !== updates.length)
      throw new Error("duplicate file update");
    for (const u of updates) {
      if (
        u.projectId !== projectId ||
        u.symbols.some(
          (s) =>
            s.projectId !== projectId ||
            s.filePath !== u.filePath ||
            s.sourceHash !== u.contentHash ||
            s.parserVersion !== u.parserVersion ||
            s.moduleId !== u.moduleId ||
            s.evidence.some(
              (e) =>
                e.projectId !== projectId ||
                e.filePath !== u.filePath ||
                e.sourceHash !== u.contentHash,
            ),
        )
      )
        throw new Error("symbol provenance mismatch");
      if (
        u.status === "fresh" &&
        (!u.contentHash ||
          u.diagnostics.some((d) => d.severity === "error") ||
          u.symbols.some((s) => s.analysisStatus !== "resolved"))
      )
        throw new Error("incomplete parse cannot be fresh");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          "SELECT payload_json,last_success_json FROM code_index_files WHERE project_id=?",
        )
        .all(projectId) as Row[];
      const current = rows.map((r) =>
        SourceFileSchema.parse(JSON.parse(r.payload_json)),
      );
      const affected = new Set(updates.map((u) => u.filePath));
      const previous = rows.flatMap((r, i) =>
        affected.has(current[i]!.filePath) && r.last_success_json
          ? SourceFileSchema.parse(JSON.parse(r.last_success_json)).symbols
          : current[i]!.status === "fresh"
            ? current[i]!.symbols
            : [],
      );
      const unchanged = current
        .filter((f) => !affected.has(f.filePath) && f.status === "fresh")
        .flatMap((f) => f.symbols);
      const matched = matchSymbols(
        [...new Map(previous.map((s) => [s.symbolUid, s])).values()],
        [
          ...unchanged,
          ...updates
            .filter((u) => u.status === "fresh")
            .flatMap((u) => u.symbols),
        ],
        renames,
      );
      for (const u of updates) {
        const row = this.db
          .prepare(
            "SELECT payload_json,last_success_json FROM code_index_files WHERE project_id=? AND file_path=?",
          )
          .get(projectId, u.filePath) as Row | undefined;
        const old = row
          ? SourceFileSchema.parse(JSON.parse(row.payload_json))
          : null;
        const success = row?.last_success_json
          ? SourceFileSchema.parse(JSON.parse(row.last_success_json))
          : null;
        const symbols =
          u.status === "fresh"
            ? matched.filter((s) => s.filePath === u.filePath)
            : u.status === "partial"
              ? matchSymbols([], u.symbols)
              : u.status === "deleted"
                ? []
                : (success?.symbols ?? []);
        const byKey = new Map(matched.map((s) => [symbolKey(s), s]));
        const relations =
          u.status === "fresh"
            ? u.relations.map((r) => {
                const source = byKey.get(r.sourceKey);
                if (!source || source.filePath !== u.filePath)
                  throw new Error("relation source not in current file");
                const target = r.targetKey ? byKey.get(r.targetKey) : null;
                return {
                  ...r,
                  projectId,
                  parserVersion: u.parserVersion,
                  indexRevision: (old?.revision ?? 0) + 1,
                  sourceUid: source.symbolUid,
                  targetUid: target?.symbolUid ?? null,
                };
              })
            : u.status === "deleted"
              ? []
              : (success?.relations ?? []);
        const state = SourceFileSchema.parse({
          ...u,
          revision: (old?.revision ?? 0) + 1,
          lastSuccessfulHash:
            u.status === "fresh"
              ? u.contentHash
              : (success?.contentHash ?? null),
          symbols: symbols.map((s) => ({
            ...s,
            parentSymbolUid: s.parentSymbolKey
              ? (byKey.get(s.parentSymbolKey)?.symbolUid ?? null)
              : s.parentSymbolUid,
            indexRevision:
              u.status === "fresh" ? (old?.revision ?? 0) + 1 : s.indexRevision,
          })),
          relations: relations.map((r) => ({
            ...r,
            indexRevision:
              u.status === "fresh" ? (old?.revision ?? 0) + 1 : r.indexRevision,
          })),
        });
        if (
          old?.status === "fresh" &&
          state.status === "fresh" &&
          comparableFacts(old) === comparableFacts(state)
        ) continue;
        const payload = JSON.stringify(state);
        this.db
          .prepare("INSERT INTO code_index_history VALUES (?,?,?,?)")
          .run(projectId, u.filePath, state.revision, payload);
        this.db
          .prepare(
            "INSERT INTO code_index_files VALUES (?,?,?,?) ON CONFLICT(project_id,file_path) DO UPDATE SET payload_json=excluded.payload_json,last_success_json=excluded.last_success_json",
          )
          .run(
            projectId,
            u.filePath,
            payload,
            u.status === "fresh" ? payload : (row?.last_success_json ?? null),
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  trustedRelations(projectId: string) {
    const files = (
      this.db
        .prepare("SELECT payload_json FROM code_index_files WHERE project_id=?")
        .all(projectId) as Row[]
    ).map((r) => SourceFileSchema.parse(JSON.parse(r.payload_json)));
    const valid = new Set(
      files
        .filter((f) => f.status === "fresh")
        .flatMap((f) => f.symbols.map((s) => s.symbolUid)),
    );
    return files
      .filter((f) => f.status === "fresh")
      .flatMap((f) => f.relations)
      .filter(
        (r) =>
          r.strength === "resolved" &&
          valid.has(r.sourceUid) &&
          r.targetUid !== null &&
          valid.has(r.targetUid),
      );
  }
}
