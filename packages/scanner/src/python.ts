import type Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { symbolKey } from "./identity.js";
import { sourcePaths } from "./files.js";
import {
  RelationDraftSchema,
  type SymbolDraft,
  type ScanDiagnostic,
} from "@archsync/contracts";
const require = createRequire(import.meta.url);
const Runtime = require(
  process.env.ARCHSYNC_PYTHON_ASSETS
    ? join(process.env.ARCHSYNC_PYTHON_ASSETS, "tree-sitter.cjs")
    : "web-tree-sitter",
) as typeof Parser;
export const PYTHON_VERSION = "python-wasm-0.20.8-0.1.13-v1";
export function pythonResources() {
  if (process.env.ARCHSYNC_PYTHON_ASSETS)
    return {
      runtime: join(process.env.ARCHSYNC_PYTHON_ASSETS, "tree-sitter.wasm"),
      grammar: join(
        process.env.ARCHSYNC_PYTHON_ASSETS,
        "tree-sitter-python.wasm",
      ),
    };
  return {
    runtime: require.resolve("web-tree-sitter/tree-sitter.wasm"),
    grammar: require.resolve("tree-sitter-wasms/out/tree-sitter-python.wasm"),
  };
}
let language: Promise<Parser.Language> | undefined;
async function load() {
  if (!language)
    language = (async () => {
      const assets = pythonResources();
      await Runtime.init({ wasmBinary: readFileSync(assets.runtime) });
      return Runtime.Language.load(readFileSync(assets.grammar));
    })();
  return language;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type N = Parser.SyntaxNode;
type Relation = ReturnType<typeof RelationDraftSchema.parse>;
const field = (n: N, name: string) => n.childForFieldName(name);
const literal = (n: N | undefined) =>
  n?.type === "string" &&
  ['"', "'"].includes(n.text[0] ?? "") &&
  !n.namedChildren.some((c) => c.type === "interpolation") &&
  !n.text.includes("\\") &&
  n.namedChildren.some((c) => c.type === "string_content")
    ? n.namedChildren
        .filter((c) => c.type === "string_content")
        .map((c) => c.text)
        .join("")
    : null;
const fingerprint = (n: N): string =>
  hash(
    JSON.stringify(
      n.namedChildren.length
        ? n.namedChildren
            .filter((c) => c.type !== "comment")
            .map((c) => fingerprint(c))
        : [n.type, n.text],
    ),
  );
export class PythonScanner {
  constructor(
    private readonly readText: (path: string) => string = (path) =>
      readFileSync(path, "utf8"),
  ) {}
  private cache = new Map<string, { hash: string; tree: Parser.Tree }>();
  async scan(root: string, projectId: string) {
    const grammar = await load();
    const parser = new Runtime();
    parser.setLanguage(grammar);
    parser.setTimeoutMicros(1000000);
    const now = new Date().toISOString();
    let parseMs = 0,
      cachedFiles = 0;
    const files = [];
    try {
      for (const path of sourcePaths(root, /\.py$/)) {
        const filePath = relative(root, path).replace(/\\/g, "/");
        const diagnostics: ScanDiagnostic[] = [];
        let text = "",
          contentHash: string | null = null;
        let status:
          | "fresh"
          | "stale"
          | "unavailable"
          | "unsupported"
          | "partial" = "fresh";
        let tree: Parser.Tree | undefined;
        try {
          text = this.readText(path);
          contentHash = hash(text);
          if (Buffer.byteLength(text) > 1024 * 1024) {
            status = "unsupported";
            throw new Error("file exceeds 1 MiB");
          }
          const prior = this.cache.get(path);
          if (prior?.hash === contentHash) {
            tree = prior.tree;
            cachedFiles++;
          } else {
            const start = performance.now();
            tree = parser.parse(text);
            parseMs += performance.now() - start;
            prior?.tree.delete();
            this.cache.set(path, { hash: contentHash, tree });
          }
          if (tree.rootNode.hasError()) status = "stale";
        } catch (error) {
          if (status !== "unsupported")
            status = contentHash ? "stale" : "unavailable";
          diagnostics.push({
            code:
              status === "unavailable"
                ? "read_error"
                : status === "unsupported"
                  ? "unsupported_structure"
                  : "parser_failure",
            message: error instanceof Error ? error.message : "parse failed",
            severity: "error",
            filePath,
            occurredAt: now,
          });
        }
        const symbols: SymbolDraft[] = [],
          relations: Relation[] = [];
        const records = new Map<number, SymbolDraft>();
        const decoratorNodes = new Map<SymbolDraft, N[]>();
        const bindings = new Map<SymbolDraft, Set<string>>();
        const imports = new Map<
          string,
          { module: string; name: string | null; bindingModule?: string }
        >();
        const apps = new Map<string, string>();
        const evidence = (n: N) => [
          {
            projectId,
            filePath,
            startLine: n.startPosition.row + 1,
            endLine: n.endPosition.row + 1,
            sourceHash: contentHash!,
            parserVersion: PYTHON_VERSION,
            strength: "observed" as const,
          },
        ];
        const add = (
          n: N,
          name: string,
          kind: SymbolDraft["kind"],
          parent: SymbolDraft | null,
          decorators: N[] = [],
        ) => {
          const body = field(n, "body");
          const params =
            field(n, "parameters")?.namedChildren.map((p) => {
              const nameNode =
                field(p, "name") ??
                (p.type === "identifier"
                  ? p
                  : (p.namedChildren.find((c) => c.type === "identifier") ??
                    p));
              return {
                name: nameNode.text,
                type: field(p, "type")?.text ?? null,
                defaultValue: field(p, "value")?.text ?? null,
                optional: !!field(p, "value"),
              };
            }) ?? [];
          const qualifiedName =
            parent && parent.kind !== "module"
              ? parent.qualifiedName + "." + name
              : name;
          const modifiers = [
            ...(n.text.startsWith("async ") ? ["async"] : []),
            ...decorators.map((d) => d.text.slice(1)),
          ];
          const s: SymbolDraft = {
            projectId,
            moduleId: filePath.split("/")[0]!,
            filePath,
            language: "python",
            kind,
            name,
            qualifiedName,
            signature: body
              ? text.slice(n.startIndex, body.startIndex).trim()
              : filePath,
            parameters: params,
            returnType: field(n, "return_type")?.text ?? null,
            exported: !name.startsWith("_"),
            visibility:
              name.startsWith("__") && !name.endsWith("__")
                ? "private"
                : "public",
            startLine: n.startPosition.row + 1,
            endLine: n.endPosition.row + 1,
            startColumn: n.startPosition.column + 1,
            endColumn: n.endPosition.column + 1,
            parentSymbolUid: null,
            parentSymbolKey: parent ? symbolKey(parent) : null,
            decorators: decorators.map((d) => d.text),
            modifiers,
            docComment:
              body?.namedChildren[0]?.type === "expression_statement" &&
              body.namedChildren[0].namedChildren[0]?.type === "string"
                ? body.namedChildren[0].namedChildren[0].text
                : null,
            sourceHash: contentHash!,
            parserVersion: PYTHON_VERSION,
            scannedAt: now,
            analysisStatus: "resolved",
            fingerprint: body ? fingerprint(body) : hash(filePath),
            declarationAnchor: hash(
              JSON.stringify([
                kind,
                qualifiedName,
                params,
                field(n, "return_type")?.text,
                modifiers,
              ]),
            ),
            overload: decorators.some((d) => d.text.includes("overload"))
              ? hash(JSON.stringify(params)) + ":overload"
              : "",
            evidence: evidence(n),
          };
          bindings.set(s, new Set(params.map((p) => p.name)));
          symbols.push(s);
          decoratorNodes.set(s, decorators);
          records.set(n.id, s);
          return s;
        };
        if (tree) {
          const node = tree.rootNode;
          const collectErrors = (n: N) => {
            if (n.type === "ERROR" || n.isMissing())
              diagnostics.push({
                code: "syntax",
                message:
                  n.type === "ERROR" ? "Python syntax error" : "missing syntax",
                severity: "error",
                filePath,
                line: n.startPosition.row + 1,
                column: n.startPosition.column + 1,
                occurredAt: now,
              });
            for (const c of n.namedChildren) collectErrors(c);
          };
          collectErrors(node);
          if (status === "fresh") {
            const module = add(node, "$file", "module", null);
            const walk = (n: N, parent: SymbolDraft, decorators: N[] = []) => {
              if (n.type === "decorated_definition") {
                const decl = n.namedChildren.find(
                  (c) =>
                    c.type === "function_definition" ||
                    c.type === "class_definition",
                );
                if (decl)
                  walk(
                    decl,
                    parent,
                    n.namedChildren.filter((c) => c.type === "decorator"),
                  );
                return;
              }
              let owner = parent;
              if (
                n.type === "class_definition" ||
                n.type === "function_definition"
              ) {
                const name = field(n, "name")!.text;
                owner = add(
                  n,
                  name,
                  n.type === "class_definition"
                    ? "class"
                    : parent.kind === "class"
                      ? name === "__init__"
                        ? "constructor"
                        : "method"
                      : "function",
                  parent,
                  decorators,
                );
              }
              if (n.type === "import_statement" && parent.kind === "module") {
                for (const child of n.namedChildren) {
                  const module = field(child, "name")?.text ?? child.text;
                  const alias =
                    field(child, "alias")?.text ?? module.split(".")[0]!;
                  imports.set(alias, {
                    module,
                    name: null,
                    bindingModule: field(child, "alias")
                      ? module
                      : module.split(".")[0],
                  });
                }
              }
              if (
                n.type === "import_from_statement" &&
                parent.kind === "module"
              ) {
                const module = field(n, "module_name")?.text ?? "";
                for (const c of n.namedChildren.filter(
                  (c) => c.id !== field(n, "module_name")?.id,
                )) {
                  const name = field(c, "name")?.text ?? c.text;
                  imports.set(field(c, "alias")?.text ?? name, {
                    module,
                    name,
                  });
                }
              }
              for (const child of n.namedChildren) walk(child, owner);
            };
            walk(node, module);
            // Exact __all__ literals override default exported visibility without evaluating Python.
            for (const child of node.namedChildren) {
              const assignment = child.namedChildren.find(
                (n) => n.type === "assignment",
              );
              if (assignment && field(assignment, "left")?.text === "__all__") {
                const list = field(assignment, "right");
                if (
                  list &&
                  ["list", "tuple"].includes(list.type) &&
                  list.namedChildren.every((n) => literal(n) !== null)
                ) {
                  const exported = new Set(
                    list.namedChildren.map((n) => literal(n)),
                  );
                  for (const s of symbols)
                    if (s.parentSymbolKey === symbolKey(module))
                      s.exported = exported.has(s.name);
                }
              }
            }
            const resolveModule = (name: string) => {
              const current = filePath
                .replace(/\.py$/, "")
                .replace(/\/__init__$/, "")
                .split("/");
              const dots = name.match(/^\.+/)?.[0].length ?? 0;
              if (dots) {
                if (!filePath.endsWith("__init__.py")) current.pop();
                return [
                  ...current.slice(0, Math.max(0, current.length - dots + 1)),
                  ...name.slice(dots).split(".").filter(Boolean),
                ].join(".");
              }
              return name;
            };
            const pending: {
              node: N;
              owner: SymbolDraft;
              target: string;
              module: string;
              name: string | null;
              kind: Relation["kind"];
            }[] = [];
            const refs = (n: N, parent: SymbolDraft) => {
              const owner = records.get(n.id) ?? parent;
              if (n.type === "assignment") {
                const binding = field(n, "left");
                if (binding?.type === "identifier")
                  bindings.get(owner)?.add(binding.text);
                const left = field(n, "left"),
                  right = field(n, "right");
                if (left?.type === "identifier" && right?.type === "call") {
                  const fn = field(right, "function")?.text ?? "";
                  const imported = imports.get(fn);
                  if (
                    imported &&
                    ["fastapi", "flask"].includes(imported.module) &&
                    ["FastAPI", "Flask"].includes(imported.name ?? "")
                  )
                    apps.set(left.text, imported.module);
                }
              }
              if (n.type === "call") {
                const fn = field(n, "function")!;
                if (fn.type === "identifier") {
                  const imported = imports.get(fn.text);
                  pending.push({
                    node: n,
                    owner,
                    target: fn.text,
                    module: imported ? resolveModule(imported.module) : "",
                    name: imported?.name ?? null,
                    kind: "calls",
                  });
                } else if (fn.type === "attribute") {
                  const object = field(fn, "object")?.text ?? "",
                    attribute = field(fn, "attribute")?.text ?? "";
                  const first = object.split(".")[0]!;
                  const imp = imports.get(first);
                  if (imp)
                    pending.push({
                      node: n,
                      owner,
                      target: attribute,
                      module:
                        resolveModule(imp.bindingModule ?? imp.module) +
                        (imp.name ? "." + imp.name : "") +
                        object.slice(first.length),
                      name: attribute,
                      kind: "calls",
                    });
                  else
                    relations.push({
                      kind: "unresolved_reference",
                      sourceKey: symbolKey(owner),
                      targetKey: null,
                      strength: "observed",
                      reason: "dynamic_call",
                      evidence: evidence(n),
                    });
                } else
                  relations.push({
                    kind: "unresolved_reference",
                    sourceKey: symbolKey(owner),
                    targetKey: null,
                    strength: "observed",
                    reason: "dynamic_call",
                    evidence: evidence(n),
                  });
              }
              for (const child of n.namedChildren) refs(child, owner);
            };
            refs(node, module);
            for (const [symbol, decorators] of decoratorNodes) {
              for (const deco of decorators) {
                const call = deco.namedChildren[0];
                if (!call || call.type !== "call") continue;
                const fn = field(call, "function");
                if (fn?.type !== "attribute") continue;
                const object = field(fn, "object")?.text ?? "",
                  method = field(fn, "attribute")?.text ?? "";
                if (
                  !apps.has(object) ||
                  !["get", "post", "put", "delete", "patch", "route"].includes(
                    method,
                  )
                )
                  continue;
                const args = field(call, "arguments")?.namedChildren ?? [];
                const path = literal(args[0]);
                if (path === null) continue;
                const methodsArg = args.find(
                  (a) =>
                    a.type === "keyword_argument" &&
                    field(a, "name")?.text === "methods",
                );
                const list = methodsArg ? field(methodsArg, "value") : null;
                const methods =
                  method === "route"
                    ? list?.type === "list"
                      ? list.namedChildren.map(literal)
                      : methodsArg
                        ? []
                        : ["GET"]
                    : [method.toUpperCase()];
                for (const verb of methods) {
                  if (verb === null) continue;
                  relations.push({
                    kind: "routes_to",
                    sourceKey: symbolKey(module),
                    targetKey: symbolKey(symbol),
                    strength: "resolved",
                    route: { path, method: verb, framework: apps.get(object)! },
                    evidence: evidence(deco),
                  });
                }
              }
            }
            files.push({
              projectId,
              moduleId: module.moduleId,
              filePath,
              language: "python" as const,
              contentHash,
              parserVersion: PYTHON_VERSION,
              configVersion: "python-index-1",
              scannedAt: now,
              status: status as
                | "fresh"
                | "partial"
                | "stale"
                | "unsupported"
                | "unavailable",
              diagnostics,
              symbols,
              relations,
              bindings,
              imports,
              resolveModule,
              pending,
            });
            continue;
          }
        }
        files.push({
          projectId,
          moduleId: filePath.split("/")[0]!,
          filePath,
          language: "python" as const,
          contentHash,
          parserVersion: PYTHON_VERSION,
          configVersion: "python-index-1",
          scannedAt: now,
          status: status as
            | "fresh"
            | "partial"
            | "stale"
            | "unsupported"
            | "unavailable",
          diagnostics,
          symbols,
          relations,
          bindings,
          imports,
          resolveModule: (s: string) => s,
          pending: [],
        });
      }
      // Bind only local, unique declarations. No package import code is executed.
      const modules = new Map(
        files.map((f) => [
          f.filePath
            .replace(/\.py$/, "")
            .replace(/\/__init__$/, "")
            .replace(/\//g, "."),
          f,
        ]),
      );
      for (const f of files) {
        if (f.status !== "fresh") continue;
        const module = f.symbols[0]!;
        for (const item of f.imports.values()) {
          const name = f.resolveModule(item.module);
          const target = modules.get(name);
          f.relations.push({
            kind: "imports",
            sourceKey: symbolKey(module),
            targetKey:
              target?.status === "fresh" ? symbolKey(target.symbols[0]!) : null,
            strength: target?.status === "fresh" ? "resolved" : "observed",
            reason:
              target?.status === "fresh"
                ? undefined
                : target
                  ? "local_unresolved"
                  : "external_dependency",
            evidence: module.evidence,
          });
        }
        for (const name of module.exportNames ?? []) {
          const imp = f.imports.get(name);
          const targetFile = imp ? modules.get(f.resolveModule(imp.module)) : f;
          const candidates =
            targetFile?.status === "fresh"
              ? targetFile.symbols.filter(
                  (s) => s.qualifiedName === (imp?.name ?? name),
                )
              : [];
          const target = candidates.length === 1 ? candidates[0] : undefined;
          f.relations.push({
            kind: "exports",
            sourceKey: symbolKey(module),
            targetKey: target ? symbolKey(target) : null,
            strength: target ? "resolved" : "observed",
            reason: target ? undefined : "local_unresolved",
            evidence: module.evidence,
          });
        }
        for (const p of f.pending) {
          let candidates: SymbolDraft[] = [];
          let targetFile = f;
          if (p.module) targetFile = modules.get(p.module) ?? f;
          if (p.module && targetFile === f && !modules.has(p.module))
            candidates = [];
          else {
            const prefixes = p.owner.qualifiedName.split(".");
            if (p.module) prefixes.length = 0;
            for (let depth = prefixes.length; depth >= 0; depth--) {
              if (
                depth > 0 &&
                p.owner.kind !== "class" &&
                targetFile.symbols.some(
                  (s) =>
                    s.kind === "class" &&
                    s.qualifiedName === prefixes.slice(0, depth).join("."),
                )
              )
                continue;
              const qualified = [
                ...prefixes.slice(0, depth),
                p.name ?? p.target,
              ].join(".");
              candidates =
                targetFile.status === "fresh"
                  ? targetFile.symbols.filter(
                      (s) =>
                        s.qualifiedName === qualified &&
                        !s.decorators.some((d) => d.includes("overload")),
                    )
                  : [];
              if (candidates.length) break;
            }
          }
          const bindingName =
            field(field(p.node, "function")!, "object")?.text.split(".")[0] ??
            p.target;
          let shadowed = false;
          let scope: SymbolDraft | undefined = p.owner;
          while (scope) {
            if (f.bindings.get(scope)?.has(bindingName)) {
              shadowed = true;
              break;
            }
            const parentKey: string | null | undefined = scope.parentSymbolKey;
            scope = f.symbols.find((s) => symbolKey(s) === parentKey);
          }
          const target =
            !shadowed && candidates.length === 1 ? candidates[0] : undefined;
          const dynamic = [
            "getattr",
            "eval",
            "exec",
            "__import__",
            "import_module",
          ].includes(p.target);
          f.relations.push({
            kind: target && !dynamic ? "calls" : "unresolved_reference",
            sourceKey: symbolKey(p.owner),
            targetKey: target && !dynamic ? symbolKey(target) : null,
            strength: target && !dynamic ? "resolved" : "observed",
            reason: dynamic
              ? "dynamic_call"
              : p.module && !modules.has(p.module)
                ? "external_dependency"
                : "local_unresolved",
            evidence: [
              {
                ...p.owner.evidence[0]!,
                startLine: p.node.startPosition.row + 1,
                endLine: p.node.endPosition.row + 1,
              },
            ],
          });
          if (!target)
            f.diagnostics.push({
              code: dynamic
                ? "dynamic_call"
                : p.module && !modules.has(p.module)
                  ? "external_dependency"
                  : "local_unresolved",
              message: "reference not statically resolved: " + p.target,
              severity: "info",
              filePath: f.filePath,
              line: p.node.startPosition.row + 1,
              occurredAt: now,
            });
        }
      }
      for (const f of files) {
        const keys = new Set<string>();
        for (const s of f.symbols) {
          const key = symbolKey(s);
          if (keys.has(key)) {
            s.overload += ":duplicate-" + f.symbols.indexOf(s);
            f.status = "partial";
            f.relations.length = 0;
            f.diagnostics.push({
              code: "unsupported_structure",
              message: "ambiguous duplicate declaration",
              severity: "error",
              filePath: f.filePath,
              occurredAt: now,
            });
          }
          keys.add(key);
        }
      }
      const live = new Set(sourcePaths(root, /\.py$/));
      for (const [key, entry] of this.cache)
        if (!live.has(key)) {
          entry.tree.delete();
          this.cache.delete(key);
        }
      return {
        updates: files.map(
          ({
            bindings: _bindings,
            imports: _imports,
            resolveModule: _resolve,
            pending: _pending,
            ...f
          }) => f,
        ),
        parseMs,
        cachedFiles,
      };
    } finally {
      parser.delete();
    }
  }
  dispose() {
    for (const c of this.cache.values()) c.tree.delete();
    this.cache.clear();
  }
}
