/**
 * Shared data contracts for ArchSync.
 *
 * Every schema here is the single source of truth for both the Fastify server
 * and the React web app. States are deliberately granular: implementation
 * evidence (files on disk) is never conflated with workflow progress
 * (issues/PRs) or presence (who is looking at the graph right now).
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Project configuration YAML (.archsync/project.yaml)                */
/* ------------------------------------------------------------------ */

export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export const GithubTargetSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  defaultBranch: z.string().min(1).default('main'),
});

export const AcceptanceSchema = z.object({
  requiredIssues: z.array(z.number().int().positive()).default([]),
  requiredChecks: z.array(z.string().min(1)).default([]),
  manualApproval: z.boolean().default(false),
});

export const LayerConfigSchema = z.object({
  id: z.string().regex(MODULE_ID_PATTERN),
  label: z.string().min(1),
  order: z.number().int().min(1),
});

export const ModuleConfigSchema = z.object({
  id: z.string().regex(MODULE_ID_PATTERN),
  label: z.string().min(1),
  layer: z.string().regex(MODULE_ID_PATTERN),
  description: z.string().default(''),
  owners: z.array(z.string().min(1)).default([]),
  paths: z.array(z.string().min(1)).default([]),
  issues: z.array(z.number().int().positive()).default([]),
  plannedDependsOn: z.array(z.string().regex(MODULE_ID_PATTERN)).default([]),
  acceptance: AcceptanceSchema.default(() => ({
    requiredIssues: [],
    requiredChecks: [],
    manualApproval: false,
  })),
});

export const ProjectConfigFileSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    id: z.string().regex(MODULE_ID_PATTERN),
    name: z.string().min(1),
    github: GithubTargetSchema,
    root: z.string().default('.'),
    /**
     * Static-site publishing gate (GitHub Pages). Snapshots of a project are
     * only written to the public static bundle when this is explicitly true.
     * Private repo paths, issues, PRs and member data must never leak into a
     * published snapshot — absence of this flag is the safe default.
     */
    publishStatic: z.boolean().optional(),
    /**
     * When publishing, allow build-time anonymous fetch of public GitHub
     * issues/PRs for the configured repository. Private repos fail anyway;
     * this flag exists so exposing collaboration data is always explicit.
     */
    publishPublicGithubData: z.boolean().optional(),
  }),
  layers: z.array(LayerConfigSchema).min(1),
  modules: z.array(ModuleConfigSchema).min(1),
});
export type ProjectConfigFile = z.infer<typeof ProjectConfigFileSchema>;

/* ------------------------------------------------------------------ */
/* Project views (.archsync/views.yaml)                               */
/* ------------------------------------------------------------------ */

export const ViewKindSchema = z.enum(['system', 'flow', 'layer']);
export type ViewKind = z.infer<typeof ViewKindSchema>;

export const ViewDirectionSchema = z.enum(['LR', 'TB']);
export type ViewDirection = z.infer<typeof ViewDirectionSchema>;

export const ViewToneSchema = z.enum([
  'blue',
  'purple',
  'cyan',
  'orange',
  'green',
  'amber',
  'red',
  'gray',
]);
export type ViewTone = z.infer<typeof ViewToneSchema>;

export const ViewGroupConfigSchema = z.object({
  id: z.string().regex(MODULE_ID_PATTERN),
  label: z.string().min(1),
  order: z.number().int().min(1),
  tone: ViewToneSchema.default('blue'),
  moduleIds: z.array(z.string().regex(MODULE_ID_PATTERN)).default([]),
});
export type ViewGroupConfig = z.infer<typeof ViewGroupConfigSchema>;

export const ProjectViewConfigSchema = z.object({
  id: z.string().regex(MODULE_ID_PATTERN),
  label: z.string().min(1),
  kind: ViewKindSchema.default('system'),
  direction: ViewDirectionSchema.default('LR'),
  description: z.string().default(''),
  groups: z.array(ViewGroupConfigSchema).min(1),
});
export type ProjectViewConfig = z.infer<typeof ProjectViewConfigSchema>;

export const ProjectViewsFileSchema = z.object({
  schemaVersion: z.literal(1),
  defaultView: z.string().regex(MODULE_ID_PATTERN).optional(),
  views: z.array(ProjectViewConfigSchema).min(1),
});
export type ProjectViewsFile = z.infer<typeof ProjectViewsFileSchema>;

/** Result of parsing + validating a project.yaml file. */
export interface ConfigError {
  path: string;
  code: string;
  message: string;
  line?: number;
  column?: number;
}

export interface ConfigParseResult {
  ok: boolean;
  config?: ProjectConfigFile;
  errors: ConfigError[];
  warnings: ConfigError[];
}

/** Structured, UI-readable diagnostics for optional project view files. */
export const ViewDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  file: z.string().min(1),
  path: z.string(),
  code: z.string(),
  message: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
export type ViewDiagnostic = z.infer<typeof ViewDiagnosticSchema>;

/* ------------------------------------------------------------------ */
/* Runtime states                                                     */
/* ------------------------------------------------------------------ */

export const ImplementationStateSchema = z.enum([
  'not_detected', // scan succeeded, zero files matched the planned globs
  'detected_unverified', // files matched but acceptance evidence incomplete
  'verified', // acceptance requirements satisfied at the target revision
  'unknown', // scan not performed or failed — must NOT be shown as absent
]);
export type ImplementationState = z.infer<typeof ImplementationStateSchema>;

export const WorkflowStateSchema = z.enum([
  'not_started',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'unknown',
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const EvidenceSourceSchema = z.enum([
  'yaml',
  'git-tree',
  'github-issue',
  'github-pr',
  'github-check',
  'manual-acceptance',
  'local-watch',
  'demo-fixture',
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceSchema = z.object({
  source: EvidenceSourceSchema,
  ref: z.string(),
  revision: z.string().optional(),
  observedAt: z.string(),
  demo: z.boolean().default(false),
  details: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/* ------------------------------------------------------------------ */
/* Collaboration data (GitHub live fetch or demo fixture)             */
/* ------------------------------------------------------------------ */

export const GithubSourceSchema = z.enum(['live', 'demo', 'unavailable']);
export type GithubSource = z.infer<typeof GithubSourceSchema>;

export const DemoIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  assignees: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  author: z.string().default('unknown'),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable().default(null),
  /** 'completed' means closed as done (GitHub reason), not merely closed. */
  completion: z.enum(['completed', 'not_completed', 'none']).default('none'),
});
export type DemoIssue = z.infer<typeof DemoIssueSchema>;

export const DemoPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().default(false),
  author: z.string(),
  assignees: z.array(z.string()).default([]),
  headRef: z.string(),
  headSha: z.string().optional(),
  changedFilesKnown: z.boolean().optional(),
  mergedAt: z.string().nullable().default(null),
  closedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  changedFiles: z.array(z.string()).default([]),
  /** check conclusion on the head commit, when known */
  checks: z.enum(['success', 'failure', 'pending', 'unknown']).default('unknown'),
});
export type DemoPullRequest = z.infer<typeof DemoPullRequestSchema>;

export const TeamMemberSchema = z.object({
  login: z.string(),
  name: z.string(),
  role: z.enum(['admin', 'maintainer', 'developer', 'viewer']),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/** Shape of collab.demo.json fixtures and of normalized live GitHub data. */
export const CollabDataSchema = z.object({
  source: GithubSourceSchema,
  demo: z.boolean().default(false),
  fetchedAt: z.string(),
  error: z.string().nullable().default(null),
  team: z.array(TeamMemberSchema).default([]),
  issues: z.array(DemoIssueSchema).default([]),
  pullRequests: z.array(DemoPullRequestSchema).default([]),
  /** extra issue numbers associated per module, beyond config `issues` */
  moduleIssues: z.record(z.array(z.number().int().positive())).default({}),
  /** recorded manual approvals per module, by maintainer login */
  manualApprovals: z.record(z.array(z.string())).default({}),
});
export type CollabData = z.infer<typeof CollabDataSchema>;

/* ------------------------------------------------------------------ */
/* Scan results (packages/scanner output)                             */
/* ------------------------------------------------------------------ */

export interface ScanOverlayChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  untracked: boolean;
}

export interface ModuleScanResult {
  moduleId: string;
  /** matched paths present in the git baseline tree (committed) */
  matchedBaselinePaths: string[];
  /** matched paths present in the live workspace */
  matchedWorkspacePaths: string[];
  /** uncommitted changes touching this module's globs */
  overlayChanges: ScanOverlayChange[];
  /** modules whose globs overlap this one on at least one file */
  overlappedWith: string[];
}

export interface ObservedDependencyEdge {
  source: string;
  target: string;
}

export interface ScanResult {
  ok: boolean;
  /** null when the scan failed — callers must surface `unknown`, never guess */
  baselineSha: string | null;
  branch: string | null;
  /** committed files at baseline */
  baselineFiles: string[];
  /** files currently on disk in the workspace */
  workspaceFiles: string[];
  overlay: ScanOverlayChange[];
  modules: ModuleScanResult[];
  errors: string[];
  scannedAt: string;
  /** true when TS/JS import analysis actually ran on workspace sources */
  importAnalysisRan: boolean;
  /** module-level dependency edges observed from real import statements */
  observedDependencies: ObservedDependencyEdge[];
}

/* ------------------------------------------------------------------ */
/* Snapshot                                                           */
/* ------------------------------------------------------------------ */

export const ModuleStateSchema = z.object({
  id: z.string(),
  label: z.string(),
  layer: z.string(),
  description: z.string(),
  plannedPaths: z.array(z.string()),
  plannedDependsOn: z.array(z.string()),
  /** module ids that depend on this module (derived) */
  dependedOnBy: z.array(z.string()),
  matchedBaselinePaths: z.array(z.string()),
  matchedWorkspacePaths: z.array(z.string()),
  overlayChanges: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['added', 'modified', 'deleted']),
      untracked: z.boolean(),
    }),
  ),
  observedDependsOn: z.nullable(z.array(z.string())).default(null),
  implementation: ImplementationStateSchema,
  workflow: WorkflowStateSchema,
  owners: z.array(z.string()),
  assignees: z.array(z.string()),
  contributors: z.array(z.string()),
  issueNumbers: z.array(z.number()),
  pullRequestNumbers: z.array(z.number()),
  evidence: z.array(EvidenceSchema),
  warnings: z.array(z.string()),
});
export type ModuleState = z.infer<typeof ModuleStateSchema>;

export const SnapshotEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  /**
   * planned   = YAML plannedDependsOn, no import evidence yet
   * observed  = real import edge the plan does not declare (drift)
   * confirmed = planned AND observed in code
   */
  kind: z.enum(['planned', 'observed', 'confirmed']),
  demo: z.boolean().default(false),
});
export type SnapshotEdge = z.infer<typeof SnapshotEdgeSchema>;

export const SnapshotSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  version: z.number().int(),
  /** snapshot scope is the local workspace clone, labelled honestly */
  branch: z.string(),
  sourceCommitSha: z.string(),
  remoteHeadSha: z.string().nullable().optional(),
  configBlobSha: z.string(),
  scope: z.literal('local-workspace'),
  generatedAt: z.string(),
  githubFetchedAt: z.string().nullable(),
  githubSource: GithubSourceSchema,
  githubDemo: z.boolean(),
  freshness: z.enum(['fresh', 'stale']),
  scanCompleteness: z.enum(['complete', 'partial', 'unknown']),
  dependencyAnalysis: z.enum(['not_supported', 'partial', 'complete']),
  layers: z.array(LayerConfigSchema),
  /** Project-specific presentation views. Optional for older snapshots. */
  views: z.array(ProjectViewConfigSchema).optional(),
  defaultViewId: z.string().nullable().optional(),
  /** Non-fatal views.yaml errors/warnings. Errors imply the auto-layer fallback was used. */
  viewDiagnostics: z.array(ViewDiagnosticSchema).optional(),
  modules: z.array(ModuleStateSchema),
  edges: z.array(SnapshotEdgeSchema),
  warnings: z.array(z.string()),
  contentHash: z.string(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/* ------------------------------------------------------------------ */
/* API payload types                                                  */
/* ------------------------------------------------------------------ */

export interface ProjectSummary {
  id: string;
  name: string;
  github: { owner: string; repo: string; defaultBranch: string };
  rootDir: string;
  demoCollab: boolean;
  moduleCount: number;
  currentVersion: number;
}

export interface ModuleDetail extends ModuleState {
  annotation: { text: string; revision: number; updatedBy: string | null; updatedAt: string | null };
}

export interface SyncJobStatus {
  id: string;
  projectId: string;
  state: 'queued' | 'running' | 'done' | 'error';
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface ApiError {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

/* ------------------------------------------------------------------ */
/* WebSocket presence protocol                                        */
/* ------------------------------------------------------------------ */

export interface PresenceParticipant {
  sessionId: string;
  userId: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selectedModuleId: string | null;
  editingField: string | null;
  mode: 'view' | 'edit';
  lastSeenAt: string;
}

export type WsClientMessage =
  | {
      type: 'presence.update';
      projectId: string;
      payload: {
        cursor?: { x: number; y: number } | null;
        selectedModuleId?: string | null;
        editingField?: string | null;
        mode?: 'view' | 'edit';
      };
    }
  | { type: 'presence.ping'; projectId: string };

export type WsServerMessage =
  | { type: 'hello'; sessionId: string; userId: string; color: string; projectId: string }
  | { type: 'presence.roster'; projectId: string; participants: PresenceParticipant[] }
  | {
      type: 'presence.changed';
      projectId: string;
      participant: PresenceParticipant;
    }
  | { type: 'presence.left'; projectId: string; sessionId: string }
  | { type: 'snapshot.published'; projectId: string; snapshotId: string; version: number }
  | { type: 'server.error'; code: string; message: string };

export * from './code-index.js';
