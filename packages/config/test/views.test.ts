import { describe, expect, it } from 'vitest';
import { parseProjectViews } from '../src/index.js';

const moduleIds = ['ui', 'api', 'store'];

const valid = `
schemaVersion: 1
defaultView: systems
views:
  - id: systems
    label: 系统视图
    kind: system
    direction: LR
    groups:
      - id: client
        label: 客户端
        order: 1
        tone: blue
        moduleIds: [ui]
      - id: backend
        label: 服务端
        order: 2
        tone: purple
        moduleIds: [api, store]
  - id: flow
    label: 流程视图
    kind: flow
    direction: LR
    groups:
      - id: request
        label: 请求
        order: 1
        moduleIds: [ui]
      - id: response
        label: 响应
        order: 2
        moduleIds: [api, store]
`;

describe('parseProjectViews', () => {
  it('accepts deterministic system and flow views', () => {
    const result = parseProjectViews(valid, moduleIds);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.file?.defaultView).toBe('systems');
    expect(result.file?.views).toHaveLength(2);
    expect(result.file?.views[0]?.groups.map((group) => group.id)).toEqual(['client', 'backend']);
    expect(result.warnings).toEqual([]);
  });

  it('rejects unknown module references', () => {
    const result = parseProjectViews(valid.replace('moduleIds: [ui]', 'moduleIds: [ghost]'), moduleIds);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === 'unknown_view_module')).toBe(true);
  });

  it('rejects duplicate modules inside one view', () => {
    const text = valid.replace('moduleIds: [api, store]', 'moduleIds: [api, store, ui]');
    const result = parseProjectViews(text, moduleIds);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === 'duplicate_view_module')).toBe(true);
  });

  it('rejects duplicate group order and unknown default view', () => {
    const text = valid
      .replace('order: 2\n        tone: purple', 'order: 1\n        tone: purple')
      .replace('defaultView: systems', 'defaultView: missing');
    const result = parseProjectViews(text, moduleIds);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === 'duplicate_group_order')).toBe(true);
    expect(result.errors.some((error) => error.code === 'unknown_default_view')).toBe(true);
  });

  it('warns about unassigned modules and defaults to the first view', () => {
    const text = valid
      .replace('defaultView: systems\n', '')
      .replace('moduleIds: [api, store]', 'moduleIds: [api]');
    const result = parseProjectViews(text, moduleIds);
    expect(result.ok).toBe(true);
    expect(result.file?.defaultView).toBe('systems');
    expect(result.warnings.some((warning) => warning.code === 'unassigned_view_modules')).toBe(true);
  });

  it('warns when a tall top-to-bottom view is likely to shrink on fit', () => {
    const text = `
schemaVersion: 1
views:
  - id: tall
    label: 纵向视图
    kind: layer
    direction: TB
    groups:
      - {id: g1, label: G1, order: 1, moduleIds: [ui]}
      - {id: g2, label: G2, order: 2, moduleIds: [api]}
      - {id: g3, label: G3, order: 3, moduleIds: [store]}
      - {id: g4, label: G4, order: 4, moduleIds: []}
      - {id: g5, label: G5, order: 5, moduleIds: []}
`;
    const result = parseProjectViews(text, moduleIds);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'tall_tb_view')).toBe(true);
  });

  it('rejects oversized or malformed YAML without throwing', () => {
    expect(parseProjectViews('views: [', moduleIds).ok).toBe(false);
    expect(parseProjectViews(`schemaVersion: 1\nviews: []\n# ${'x'.repeat(300_000)}`, moduleIds).ok).toBe(false);
  });
});