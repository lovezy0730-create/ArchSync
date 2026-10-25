import { describe, expect, it } from 'vitest';
import {
  CollabDataSchema,
  ModuleStateSchema,
  SnapshotSchema,
  WorkflowStateSchema,
  ImplementationStateSchema,
} from '../src/index.js';

describe('contracts schemas', () => {
  it('accepts the documented state enums', () => {
    expect(ImplementationStateSchema.options).toEqual([
      'not_detected',
      'detected_unverified',
      'verified',
      'unknown',
    ]);
    expect(WorkflowStateSchema.options).toEqual([
      'not_started',
      'in_progress',
      'in_review',
      'blocked',
      'done',
      'unknown',
    ]);
  });

  it('parses collab fixtures and defaults collections', () => {
    const parsed = CollabDataSchema.parse({
      source: 'demo',
      demo: true,
      fetchedAt: '2026-01-01T00:00:00Z',
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.team).toEqual([]);
    expect(parsed.manualApprovals).toEqual({});
  });

  it('validates a minimal snapshot shape', () => {
    const snapshot = SnapshotSchema.parse({
      id: 's1',
      projectId: 'p1',
      projectName: 'P',
      version: 1,
      branch: 'main',
      sourceCommitSha: 'a'.repeat(40),
      configBlobSha: 'b'.repeat(40),
      scope: 'local-workspace',
      generatedAt: '2026-01-01T00:00:00Z',
      githubFetchedAt: null,
      githubSource: 'unavailable',
      githubDemo: false,
      freshness: 'fresh',
      scanCompleteness: 'complete',
      dependencyAnalysis: 'not_supported',
      layers: [{ id: 'ui', label: 'UI', order: 1 }],
      modules: [
        ModuleStateSchema.parse({
          id: 'm1',
          label: 'M',
          layer: 'ui',
          description: '',
          plannedPaths: [],
          plannedDependsOn: [],
          dependedOnBy: [],
          matchedBaselinePaths: [],
          matchedWorkspacePaths: [],
          overlayChanges: [],
          implementation: 'not_detected',
          workflow: 'not_started',
          owners: [],
          assignees: [],
          contributors: [],
          issueNumbers: [],
          pullRequestNumbers: [],
          evidence: [],
          warnings: [],
        }),
      ],
      edges: [],
      warnings: [],
      contentHash: 'abc123',
    });
    expect(snapshot.modules[0]?.observedDependsOn).toBeNull();
    expect(snapshot.modules[0]?.implementation).toBe('not_detected');
  });
});
