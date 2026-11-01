import { z } from 'zod';

/**
 * Unified architecture projection.
 *
 * One graph contract for every level the workbench can drill into:
 * system → module → file → symbol. Nodes carry their origin (planned vs
 * observed) and every edge keeps the evidence kind that produced it, so the
 * UI can never present an inferred or unresolved relation as a resolved call.
 */
export const ArchitectureLevelSchema = z.enum(['system', 'module', 'file', 'symbol']);
export type ArchitectureLevel = z.infer<typeof ArchitectureLevelSchema>;

export const ArchitectureNodeKindSchema = z.enum([
  'system',
  'module',
  'file',
  'function',
  'class',
  'interface',
  'type',
  'constructor',
  'endpoint',
  'variable',
  'unknown',
]);
export type ArchitectureNodeKind = z.infer<typeof ArchitectureNodeKindSchema>;

/**
 * - planned    declared by project.yaml, no code evidence
 * - observed   seen in code but the target could not be resolved to a symbol
 * - resolved   resolved to a concrete symbol/file by the scanner
 * - inferred   structural inference (module clustering), not a call fact
 * - unresolved a reference the scanner could not resolve (dynamic/external)
 * - stale      one endpoint is not fresh in the index
 */
export const ArchitectureEdgeKindSchema = z.enum([
  'planned',
  'observed',
  'resolved',
  'inferred',
  'unresolved',
  'stale',
]);
export type ArchitectureEdgeKind = z.infer<typeof ArchitectureEdgeKindSchema>;

export const ArchitectureEvidenceSchema = z.object({
  source: z.string(),
  ref: z.string(),
  detail: z.string().optional(),
});
export type ArchitectureEvidence = z.infer<typeof ArchitectureEvidenceSchema>;

export const ArchitectureNodeSchema = z.object({
  id: z.string(),
  level: ArchitectureLevelSchema,
  kind: ArchitectureNodeKindSchema,
  label: z.string(),
  parentId: z.string().nullable(),
  moduleId: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  symbolUid: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  status: z.enum(['fresh', 'stale', 'partial', 'unavailable', 'unknown']).default('unknown'),
  planned: z.boolean().default(false),
  observed: z.boolean().default(false),
  confidence: z.enum(['high', 'medium', 'low', 'none']).default('none'),
  counts: z
    .object({
      files: z.number().int().nonnegative().default(0),
      symbols: z.number().int().nonnegative().default(0),
      functions: z.number().int().nonnegative().default(0),
      classes: z.number().int().nonnegative().default(0),
      interfaces: z.number().int().nonnegative().default(0),
    })
    .default({ files: 0, symbols: 0, functions: 0, classes: 0, interfaces: 0 }),
  evidence: z.array(ArchitectureEvidenceSchema).default([]),
  /** Free-form extras (e.g. discovery rule, unresolved reason). */
  meta: z.record(z.unknown()).optional(),
});
export type ArchitectureNode = z.infer<typeof ArchitectureNodeSchema>;

export const ArchitectureEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: ArchitectureEdgeKindSchema,
  count: z.number().int().positive().default(1),
  label: z.string().nullable().optional(),
  confidence: z.enum(['high', 'medium', 'low', 'none']).default('none'),
  evidence: z
    .array(
      z.object({
        filePath: z.string(),
        startLine: z.number().int().positive().nullable().optional(),
        detail: z.string().optional(),
      }),
    )
    .default([]),
});
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;

export const ArchitectureDiagnosticSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  message: z.string(),
});
export type ArchitectureDiagnostic = z.infer<typeof ArchitectureDiagnosticSchema>;

export const ArchitectureScopeSchema = z.object({
  systemId: z.string().nullable().default(null),
  moduleId: z.string().nullable().default(null),
  filePath: z.string().nullable().default(null),
});
export type ArchitectureScope = z.infer<typeof ArchitectureScopeSchema>;

export const ArchitectureResponseSchema = z.object({
  projectId: z.string(),
  level: ArchitectureLevelSchema,
  scope: ArchitectureScopeSchema,
  generatedAt: z.string(),
  /** Monotonic-ish index revision used by clients to discard stale responses. */
  indexVersion: z.number().int().nonnegative(),
  /** True when any included file is not fresh in the index. */
  stale: z.boolean(),
  plannedAvailable: z.boolean(),
  nodes: z.array(ArchitectureNodeSchema),
  edges: z.array(ArchitectureEdgeSchema),
  diagnostics: z.array(ArchitectureDiagnosticSchema),
  summary: z.object({
    systems: z.number().int().nonnegative(),
    modules: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    resolvedEdges: z.number().int().nonnegative(),
    unresolvedEdges: z.number().int().nonnegative(),
    plannedEdges: z.number().int().nonnegative(),
  }),
});
export type ArchitectureResponse = z.infer<typeof ArchitectureResponseSchema>;

/** Lightweight status for polling without transferring the whole index. */
export const CodeIndexStatusSchema = z.object({
  projectId: z.string(),
  state: z.enum(['idle', 'scanning', 'ready', 'error', 'unavailable']),
  error: z.string().nullable(),
  scannedAt: z.string().nullable(),
  /** Sum of file revisions; changes whenever the index commits an update. */
  indexVersion: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
});
export type CodeIndexStatus = z.infer<typeof CodeIndexStatusSchema>;
