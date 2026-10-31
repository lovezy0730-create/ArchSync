import { createHash, randomUUID } from "node:crypto";
import {
  SymbolDraftSchema,
  CodeSymbolSchema,
  type SymbolDraft,
  type CodeSymbol,
} from "@archsync/contracts";
export const IDENTITY_VERSION = "rc5-identity-2";
export function symbolKey(s: SymbolDraft): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        s.projectId,
        s.language,
        s.filePath,
        s.qualifiedName,
        s.kind,
        s.overload,
      ]),
    )
    .digest("hex");
}
/** Fingerprints must encode AST structure, excluding declared name and location. Never name similarity. */
export function matchSymbols(
  previous: CodeSymbol[],
  inputs: SymbolDraft[],
  renames: Record<string, string> = {},
): CodeSymbol[] {
  const drafts = inputs.map((i) => SymbolDraftSchema.parse(i));
  const keys = drafts.map(symbolKey);
  if (new Set(keys).size !== keys.length)
    throw new Error("duplicate symbolKey: provide overload discriminator");
  const used = new Set<string>();
  const compatible = (a: SymbolDraft, b: SymbolDraft) =>
    a.projectId === b.projectId &&
    a.language === b.language &&
    a.kind === b.kind &&
    a.parserVersion === b.parserVersion &&
    a.fingerprint === b.fingerprint;
  // Index the previous generation instead of scanning it once per draft:
  // large repositories repeat the same structural fingerprint thousands of
  // times, which made the naive filter quadratic (multi-second on 1000 files).
  const compatibleKey = (s: SymbolDraft) =>
    [s.projectId, s.language, s.kind, s.parserVersion, s.fingerprint].join("\u0000");
  const siblingGroup = (s: {
    projectId: string;
    filePath: string;
    parentSymbolKey?: string | null;
  }) => JSON.stringify([s.projectId, s.filePath, s.parentSymbolKey ?? null]);
  const groupKeys = <T extends { symbolKey: string }>(
    items: T[],
    group: (item: T) => string,
  ): Map<string, string> => {
    const groups = new Map<string, string[]>();
    for (const item of items) {
      const key = group(item);
      const list = groups.get(key);
      if (list) list.push(item.symbolKey);
      else groups.set(key, [item.symbolKey]);
    }
    const serialized = new Map<string, string>();
    for (const [key, list] of groups) serialized.set(key, JSON.stringify([...list].sort()));
    return serialized;
  };
  const previousByKey = new Map<string, CodeSymbol[]>();
  const previousByCompatible = new Map<string, CodeSymbol[]>();
  const previousKeysByFingerprint = new Map<string, Set<string>>();
  for (const p of previous) {
    const byKey = previousByKey.get(p.symbolKey);
    if (byKey) byKey.push(p);
    else previousByKey.set(p.symbolKey, [p]);
    const ck = compatibleKey(p);
    const byCompatible = previousByCompatible.get(ck);
    if (byCompatible) byCompatible.push(p);
    else previousByCompatible.set(ck, [p]);
    const fingerprintKeys = previousKeysByFingerprint.get(p.fingerprint);
    if (fingerprintKeys) fingerprintKeys.add(p.symbolKey);
    else previousKeysByFingerprint.set(p.fingerprint, new Set([p.symbolKey]));
  }
  const draftCompatibleCount = new Map<string, number>();
  const draftKeysByFingerprint = new Map<string, Set<string>>();
  for (const d of drafts) {
    const ck = compatibleKey(d);
    draftCompatibleCount.set(ck, (draftCompatibleCount.get(ck) ?? 0) + 1);
    const fingerprintKeys = draftKeysByFingerprint.get(d.fingerprint);
    if (fingerprintKeys) fingerprintKeys.add(symbolKey(d));
    else draftKeysByFingerprint.set(d.fingerprint, new Set([symbolKey(d)]));
  }
  const previousSiblings = groupKeys(previous, siblingGroup);
  const draftSiblings = groupKeys(
    drafts.map((d, i) => ({ ...d, symbolKey: keys[i]! })),
    siblingGroup,
  );
  const renameSources = Object.keys(renames);
  return drafts.map((s, index) => {
    const ck = compatibleKey(s);
    const candidates = () => previousByCompatible.get(ck) ?? [];
    // `exact` only ever inspects previous symbols with this symbolKey, so the
    // key bucket replaces a full-generation scan.
    const exact: CodeSymbol[] = [];
    for (const p of previousByKey.get(keys[index]!) ?? []) {
      if (p.parserVersion !== s.parserVersion) continue;
      if (p.fingerprint === s.fingerprint) {
        exact.push(p);
        continue;
      }
      if (!s.declarationAnchor || p.declarationAnchor !== s.declarationAnchor)
        continue;
      if (previousSiblings.get(siblingGroup(s)) !== draftSiblings.get(siblingGroup(s)))
        continue;
      const draftFingerprintKeys = draftKeysByFingerprint.get(p.fingerprint);
      if (draftFingerprintKeys && [...draftFingerprintKeys].some((key) => key !== keys[index]))
        continue;
      const previousFingerprintKeys = previousKeysByFingerprint.get(s.fingerprint);
      if (
        previousFingerprintKeys &&
        (previousFingerprintKeys.size > 1 || !previousFingerprintKeys.has(p.symbolKey))
      )
        continue;
      exact.push(p);
    }
    // With no rename mapping, `moved` can never match; skip the bucket scan.
    const moved =
      renameSources.length === 0
        ? []
        : candidates().filter(
            (p) =>
              renames[p.filePath] === s.filePath &&
              p.qualifiedName === s.qualifiedName &&
              p.overload === s.overload,
          );
    const unique =
      (previousByCompatible.get(ck)?.length ?? 0) === 1 &&
      draftCompatibleCount.get(ck) === 1;
    const old =
      exact.length === 1
        ? exact[0]
        : moved.length === 1 &&
            drafts.filter((d) => compatible(d, s)).length === 1
          ? moved[0]
          : unique
            ? candidates()[0]
            : undefined;
    const valid = old && !used.has(old.symbolUid) ? old : undefined;
    if (valid) used.add(valid.symbolUid);
    const predecessors = valid ? [] : candidates().map((p) => p.symbolUid);
    return CodeSymbolSchema.parse({
      ...s,
      symbolKey: keys[index],
      symbolUid: valid?.symbolUid ?? randomUUID(),
      possiblePredecessors: valid ? [] : predecessors,
      identity: {
        reason: valid
          ? exact.includes(valid)
            ? "same-declaration"
            : moved.includes(valid)
              ? "git-rename"
              : "unique-structure"
          : "new",
        confidence: valid ? "high" : "none",
        version: IDENTITY_VERSION,
        previousKey: valid?.symbolKey ?? null,
      },
    });
  });
}
