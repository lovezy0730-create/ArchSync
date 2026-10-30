import { z } from "zod";
export const RelativeSourcePathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.includes("\0") &&
      !p.startsWith("/") &&
      !/^[A-Za-z]:/.test(p) &&
      p.split("/").every((s) => s !== "." && s !== ".." && s !== ""),
    "expected normalized repository-relative path",
  );
const id = z.string().min(1);
export const IndexStatusSchema = z.enum([
  "fresh",
  "partial",
  "stale",
  "unsupported",
  "unavailable",
  "deleted",
]);
export const SymbolEvidenceSchema = z
  .object({
    projectId: id,
    filePath: RelativeSourcePathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    sourceHash: id,
    parserVersion: id,
    strength: z.enum(["observed", "resolved", "inferred"]),
  })
  .refine((e) => e.endLine >= e.startLine);
export type SymbolEvidence = z.infer<typeof SymbolEvidenceSchema>;
export const ScanDiagnosticSchema = z.object({
  code: id,
  message: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  filePath: RelativeSourcePathSchema,
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  occurredAt: z.string().datetime(),
});
export type ScanDiagnostic = z.infer<typeof ScanDiagnosticSchema>;
export const ScanIndexMetadataSchema = z.object({
  projectId: id,
  revision: z.number().int().nonnegative(),
  parserVersion: id,
  configVersion: id,
  scannedAt: z.string().datetime(),
  sourceHash: z.string().nullable(),
});
export type ScanIndexMetadata = z.infer<typeof ScanIndexMetadataSchema>;
export const SystemSchema = z.object({
  systemId: id,
  projectId: id,
  name: id,
  moduleIds: z.array(id),
  origin: z.enum(["workspace", "directory", "user"]),
  confidence: z.number().min(0).max(1),
});
export type System = z.infer<typeof SystemSchema>;
export const ModuleSchema = z.object({
  moduleId: id,
  systemId: id,
  projectId: id,
  name: id,
  paths: z.array(RelativeSourcePathSchema),
  origin: z.enum(["package", "directory", "user", "inferred"]),
  confidence: z.number().min(0).max(1),
  sourceFileCount: z.number().int().nonnegative(),
  symbolCount: z.number().int().nonnegative(),
  headSha: z.string().nullable(),
  scannedAt: z.string().datetime(),
  planMatch: z.enum(["planned_only", "observed_only", "matched", "unknown"]),
});
export type Module = z.infer<typeof ModuleSchema>;
export const SymbolDraftSchema = z.object({
  projectId: id,
  moduleId: id,
  filePath: RelativeSourcePathSchema,
  language: z.enum(["typescript", "javascript", "python"]),
  kind: z.enum([
    "function",
    "method",
    "class",
    "interface",
    "type",
    "constructor",
    "endpoint",
  ]),
  name: id,
  qualifiedName: id,
  signature: z.string(),
  overload: z.string(),
  parameters: z.array(
    z.object({
      name: id,
      type: z.string().nullable(),
      defaultValue: z.string().nullable(),
      optional: z.boolean(),
    }),
  ),
  returnType: z.string().nullable(),
  exported: z.boolean().nullable(),
  visibility: z.enum(["public", "protected", "private", "unknown"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  parentSymbolUid: z.string().nullable(),
  decorators: z.array(z.string()),
  modifiers: z.array(z.string()),
  docComment: z.string().nullable(),
  sourceHash: id,
  parserVersion: id,
  scannedAt: z.string().datetime(),
  analysisStatus: z.enum(["resolved", "partial", "unsupported", "failed"]),
  evidence: z.array(SymbolEvidenceSchema),
  fingerprint: id,
});
export type SymbolDraft = z.infer<typeof SymbolDraftSchema>;
export const CodeSymbolSchema = SymbolDraftSchema.extend({
  symbolUid: id,
  indexRevision: z.number().int().positive().default(1),
  symbolKey: id,
  possiblePredecessors: z.array(id),
  identity: z.object({
    reason: z.enum([
      "new",
      "same-declaration",
      "git-rename",
      "unique-structure",
    ]),
    confidence: z.enum(["none", "high"]),
    version: id,
    previousKey: z.string().nullable(),
  }),
}).refine((s) => s.endLine >= s.startLine);
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;
export const RelationDraftSchema = z.object({
  kind: z.enum([
    "contains",
    "imports",
    "calls",
    "exports",
    "implements",
    "routes_to",
    "planned_depends_on",
    "unresolved_reference",
  ]),
  sourceKey: id,
  targetKey: z.string().nullable(),
  strength: z.enum(["observed", "resolved", "inferred"]),
  evidence: z.array(SymbolEvidenceSchema),
});
export const CodeRelationSchema = RelationDraftSchema.extend({
  sourceUid: id,
  indexRevision: z.number().int().positive().default(1),
  targetUid: z.string().nullable(),
  projectId: id,
  parserVersion: id,
});
export type CodeRelation = z.infer<typeof CodeRelationSchema>;
export const SourceFileSchema = z.object({
  projectId: id,
  moduleId: id,
  filePath: RelativeSourcePathSchema,
  language: z.enum(["typescript", "javascript", "python", "unknown"]),
  sizeBytes: z.number().int().nonnegative().optional(),
  status: IndexStatusSchema,
  contentHash: z.string().nullable(),
  lastSuccessfulHash: z.string().nullable(),
  parserVersion: id,
  configVersion: id,
  scannedAt: z.string().datetime(),
  revision: z.number().int().positive(),
  symbols: z.array(CodeSymbolSchema),
  relations: z.array(CodeRelationSchema),
  diagnostics: z.array(ScanDiagnosticSchema),
});
export type SourceFile = z.infer<typeof SourceFileSchema>;
