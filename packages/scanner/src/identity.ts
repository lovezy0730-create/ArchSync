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
  return drafts.map((s, index) => {
    const candidates = previous.filter((p) => compatible(s, p));
    const exact = previous.filter(
      (p) =>
        p.symbolKey === keys[index] &&
        p.parserVersion === s.parserVersion &&
        (p.fingerprint === s.fingerprint ||
          (s.declarationAnchor &&
            p.declarationAnchor === s.declarationAnchor &&
            JSON.stringify(
              previous
                .filter(
                  (d) =>
                    d.projectId === s.projectId &&
                    d.filePath === s.filePath &&
                    d.parentSymbolKey === s.parentSymbolKey,
                )
                .map(symbolKey)
                .sort(),
            ) ===
              JSON.stringify(
                drafts
                  .filter(
                    (d) =>
                      d.projectId === s.projectId &&
                      d.filePath === s.filePath &&
                      d.parentSymbolKey === s.parentSymbolKey,
                  )
                  .map(symbolKey)
                  .sort(),
              ) &&
            !drafts.some(
              (d) =>
                symbolKey(d) !== keys[index] && d.fingerprint === p.fingerprint,
            ) &&
            !previous.some(
              (d) =>
                d.symbolKey !== p.symbolKey && d.fingerprint === s.fingerprint,
            ))),
    );
    const moved = candidates.filter(
      (p) =>
        renames[p.filePath] === s.filePath &&
        p.qualifiedName === s.qualifiedName &&
        p.overload === s.overload,
    );
    const unique =
      candidates.length === 1 &&
      drafts.filter((d) => compatible(d, s)).length === 1;
    const old =
      exact.length === 1
        ? exact[0]
        : moved.length === 1 &&
            drafts.filter((d) => compatible(d, s)).length === 1
          ? moved[0]
          : unique
            ? candidates[0]
            : undefined;
    const valid = old && !used.has(old.symbolUid) ? old : undefined;
    if (valid) used.add(valid.symbolUid);
    return CodeSymbolSchema.parse({
      ...s,
      symbolKey: keys[index],
      symbolUid: valid?.symbolUid ?? randomUUID(),
      possiblePredecessors: valid ? [] : candidates.map((p) => p.symbolUid),
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
