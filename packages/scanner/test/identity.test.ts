import { it, expect } from "vitest";
import { matchSymbols, symbolKey } from "../src/identity.js";

const draft = (
  name = "f",
  fingerprint = "body",
  filePath = "src/a.ts",
  overrides: Record<string, unknown> = {},
) => ({
  projectId: "p",
  moduleId: "m",
  filePath,
  language: "typescript" as const,
  kind: "function" as const,
  name,
  qualifiedName: name,
  signature: `${name}()`,
  overload: "",
  parameters: [],
  returnType: null,
  exported: true,
  visibility: "public" as const,
  startLine: 1,
  endLine: 3,
  parentSymbolUid: null,
  decorators: [],
  modifiers: [],
  docComment: null,
  sourceHash: "hash",
  parserVersion: "fixture-1",
  scannedAt: "2026-10-30T00:00:00Z",
  analysisStatus: "resolved" as const,
  evidence: [],
  fingerprint,
  ...overrides,
});

const first = (
  previous: ReturnType<typeof matchSymbols>,
  inputs: ReturnType<typeof draft>[],
) => matchSymbols(previous, inputs);

it("reuses the UID for the same declaration and reports the reason", () => {
  const start = first([], [draft()]);
  const again = first(start, [draft()]);
  expect(again[0]!.symbolUid).toBe(start[0]!.symbolUid);
  expect(again[0]!.identity.reason).toBe("same-declaration");
});

it("keeps the UID across a git rename, matching by structure and name", () => {
  const start = first([], [draft("f", "body", "src/a.ts")]);
  const moved = matchSymbols(start, [draft("f", "body", "src/b.ts")], { "src/a.ts": "src/b.ts" });
  expect(moved[0]!.symbolUid).toBe(start[0]!.symbolUid);
  expect(moved[0]!.identity.reason).toBe("git-rename");
});

it("matches the only structurally compatible symbol as unique-structure", () => {
  const start = first([], [draft()]);
  const renamed = first(start, [draft("g")]);
  expect(renamed[0]!.symbolKey).toBe(symbolKey(draft("g")));
  expect(renamed[0]!.symbolUid).toBe(start[0]!.symbolUid);
  expect(renamed[0]!.identity.reason).toBe("unique-structure");
});

it("treats a changed body as a new symbol without stealing the old UID", () => {
  const start = first([], [draft("f", "old-body")]);
  const next = first(start, [draft("f", "new-body")]);
  expect(next[0]!.symbolUid).not.toBe(start[0]!.symbolUid);
  expect(next[0]!.identity.reason).toBe("new");
  expect(next[0]!.possiblePredecessors).toEqual([]);
});

it("does not guess when several previous symbols share the structural fingerprint", () => {
  const start = first([], [draft("a"), draft("b")]);
  const next = first(start, [draft("c")]);
  expect(next[0]!.identity.reason).toBe("new");
  expect(next[0]!.possiblePredecessors.sort()).toEqual(start.map((s) => s.symbolUid).sort());
});

it("matches an ambiguous sibling only when the declaration anchor is stable", () => {
  const anchored = (name: string, fingerprint: string) =>
    draft(name, fingerprint, "src/a.ts", { declarationAnchor: "anchor-1" });
  const start = first([], [anchored("a", "v1"), anchored("b", "v1")]);
  const next = first(start, [anchored("a", "v2"), anchored("b", "v2")]);
  expect(next[0]!.symbolUid).toBe(start[0]!.symbolUid);
  expect(next[1]!.symbolUid).toBe(start[1]!.symbolUid);
});
