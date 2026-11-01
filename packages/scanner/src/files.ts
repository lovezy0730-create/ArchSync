import ignoreFactory, { type Ignore } from "ignore";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
const createIgnore = ignoreFactory as unknown as () => Ignore;
const norm = (s: string) => resolve(s).replace(/\\/g, "/");
const skip = new Set([
  "node_modules",
  ".git",
  ".local",
  "dist",
  "build",
  "release",
  "coverage",
  ".venv",
  "venv",
]);
export function sourcePaths(
  root: string,
  pattern: RegExp = /\.(tsx?|jsx?|mjs|cjs)$/,
): string[] {
  const out: string[] = [];
  const walk = (
    dir: string,
    inherited: { base: string; rules: Ignore }[] = [],
  ) => {
    const rules = [...inherited];
    try {
      rules.push({
        base: dir,
        rules: createIgnore().add(
          readFileSync(join(dir, ".gitignore"), "utf8"),
        ),
      });
    } catch {
      /* optional ignore file */
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink() || skip.has(e.name)) continue;
      const path = join(dir, e.name);
      let ignored = false;
      for (const rule of rules) {
        const rel =
          relative(rule.base, path).replace(/\\/g, "/") +
          (e.isDirectory() ? "/" : "");
        const result = rule.rules.test(rel);
        if (result.ignored) ignored = true;
        if (result.unignored) ignored = false;
      }
      if (ignored) continue;
      if (e.isDirectory()) walk(path, rules);
      else if (pattern.test(e.name)) out.push(norm(path));
    }
  };
  walk(root);
  return out.sort();
}
