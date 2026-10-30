import ts from "typescript";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import type { SymbolDraft, ScanDiagnostic } from "@archsync/contracts";
import { symbolKey } from "./identity.js";
export const AST_VERSION = `ts-${ts.version}-rc5-ast-1`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
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
export function sourcePaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink() || skip.has(e.name)) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e.name)) out.push(norm(path));
    }
  };
  walk(root);
  return out.sort();
}
export class AstScanner {
  private cache = new Map<string, { hash: string; source: ts.SourceFile }>();
  scan(root: string, projectId: string) {
    root = norm(root);
    const paths = sourcePaths(root);
    const now = new Date().toISOString();
    const texts = new Map<string, string>();
    const errors = new Map<string, string>();
    for (const path of paths) {
      try {
        const text = readFileSync(path, "utf8");
        if (Buffer.byteLength(text) > 1024 * 1024)
          errors.set(path, "file exceeds 1 MiB limit");
        else texts.set(path, text);
      } catch {
        errors.set(path, "file unavailable");
      }
    }
    let options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      noLib: true,
      skipLibCheck: true,
    };
    try {
      const raw = ts.parseConfigFileTextToJson(
        join(root, "tsconfig.json"),
        readFileSync(join(root, "tsconfig.json"), "utf8"),
      );
      if (!raw.error)
        options = {
          ...options,
          ...ts.convertCompilerOptionsFromJson(
            raw.config.compilerOptions ?? {},
            root,
          ).options,
          noLib: true,
          allowJs: true,
        };
    } catch {
      /* optional config */
    }
    const workspacePaths: Record<string, string[]> = {};
    for (const folder of ["packages", "apps"]) {
      try {
        for (const e of readdirSync(join(root, folder), {
          withFileTypes: true,
        })) {
          if (!e.isDirectory() || e.isSymbolicLink()) continue;
          try {
            const pkg = JSON.parse(
              readFileSync(join(root, folder, e.name, "package.json"), "utf8"),
            ) as { name?: string };
            if (pkg.name) {
              workspacePaths[pkg.name] = [`${folder}/${e.name}/src/index.ts`];
              workspacePaths[pkg.name + "/*"] = [`${folder}/${e.name}/src/*`];
            }
          } catch {
            /* not a package */
          }
        }
      } catch {
        /* optional workspace */
      }
    }
    options.baseUrl ??= root;
    options.paths = { ...workspacePaths, ...options.paths };
    const host = ts.createCompilerHost(options);
    let parseMs = 0,
      cachedFiles = 0;
    host.readFile = (p) => texts.get(norm(p));
    host.fileExists = (p) => texts.has(norm(p));
    host.directoryExists = (p) =>
      paths.some((f) => f.startsWith(norm(p) + "/"));
    host.getCurrentDirectory = () => root;
    host.getSourceFile = (p, languageVersion) => {
      const key = norm(p),
        text = texts.get(key);
      if (text === undefined) return undefined;
      const h = hash(text + JSON.stringify(options) + AST_VERSION),
        old = this.cache.get(key);
      if (old?.hash === h) {
        cachedFiles++;
        return old.source;
      }
      const start = performance.now();
      const source = ts.createSourceFile(
        key,
        text,
        languageVersion,
        true,
        /\.tsx$/.test(key)
          ? ts.ScriptKind.TSX
          : /\.jsx$/.test(key)
            ? ts.ScriptKind.JSX
            : /\.(js|mjs|cjs)$/.test(key)
              ? ts.ScriptKind.JS
              : ts.ScriptKind.TS,
      );
      parseMs += performance.now() - start;
      this.cache.set(key, { hash: h, source });
      return source;
    };
    const program = ts.createProgram(
      paths.filter((p) => texts.has(p)),
      options,
      host,
    );
    const checker = program.getTypeChecker();
    type Relation = {
      kind: "calls" | "imports" | "exports" | "unresolved_reference";
      sourceKey: string;
      targetKey: string | null;
      strength: "observed" | "resolved";
      evidence: SymbolDraft["evidence"];
    };
    const records = new Map<ts.Node, SymbolDraft>();
    const files = [];
    for (const path of paths) {
      const source = program.getSourceFile(path);
      const text = texts.get(path) ?? "";
      const filePath = relative(root, path).replace(/\\/g, "/");
      const language = /\.(js|jsx|mjs|cjs)$/.test(path)
        ? ("javascript" as const)
        : ("typescript" as const);
      const contentHash = texts.has(path) ? hash(text) : null;
      const diagnostics: ScanDiagnostic[] = (
        source ? program.getSyntacticDiagnostics(source) : []
      ).map((d) => {
        const lc = source!.getLineAndCharacterOfPosition(d.start ?? 0);
        return {
          code: String(d.code),
          message: ts.flattenDiagnosticMessageText(d.messageText, " "),
          severity: "error",
          filePath,
          line: lc.line + 1,
          column: lc.character + 1,
          occurredAt: now,
        };
      });
      if (errors.has(path))
        diagnostics.push({
          code: "read",
          message: errors.get(path)!,
          severity: "error",
          filePath,
          occurredAt: now,
        });
      const symbols: SymbolDraft[] = [];
      const relations: Relation[] = [];
      const evidence = (node: ts.Node) => {
        const a = source!.getLineAndCharacterOfPosition(node.getStart(source)),
          b = source!.getLineAndCharacterOfPosition(node.getEnd());
        return [
          {
            projectId,
            filePath,
            startLine: a.line + 1,
            endLine: b.line + 1,
            sourceHash: contentHash!,
            parserVersion: AST_VERSION,
            strength: "observed" as const,
          },
        ];
      };
      function add(
        node: ts.Node,
        name: string,
        kind: SymbolDraft["kind"],
        parent: SymbolDraft | null,
      ) {
        const fn =
          ts.isFunctionLike(node) && !ts.isCallSignatureDeclaration(node)
            ? node
            : undefined;
        const mods = ts.canHaveModifiers(node)
          ? (ts.getModifiers(node) ?? []).map((m) => m.getText(source))
          : [];
        const params =
          fn?.parameters.map((p) => ({
            name: p.name.getText(source),
            type: p.type?.getText(source) ?? null,
            defaultValue: p.initializer?.getText(source) ?? null,
            optional: !!p.questionToken || !!p.initializer,
          })) ?? [];
        const body = fn && "body" in fn ? fn.body : undefined;
        const signature =
          node === source
            ? filePath
            : body
              ? text.slice(node.getStart(source), body.getStart(source)).trim()
              : node.getText(source);
        const range = evidence(node)[0]!;
        const begin = source!.getLineAndCharacterOfPosition(
            node.getStart(source),
          ),
          end = source!.getLineAndCharacterOfPosition(node.getEnd());
        const qualifiedName =
          parent && parent.kind !== "module"
            ? parent.qualifiedName + "." + name
            : name;
        const doc =
          ts
            .getJSDocCommentsAndTags(node)
            .map((d) => d.getText(source))
            .join("\n") || null;
        const draft: SymbolDraft = {
          projectId,
          moduleId: filePath.split("/")[0] ?? "root",
          filePath,
          language,
          kind,
          name,
          qualifiedName,
          signature,
          parameters: params,
          returnType: fn?.type?.getText(source) ?? null,
          overload: fn
            ? hash(
                JSON.stringify(params.map((p) => [p.name, p.type, p.optional])),
              ) + (body ? ":body" : ":declaration")
            : "",
          exported:
            mods.includes("export") ||
            mods.includes("default") ||
            !!(parent && parent.exported),
          visibility: mods.includes("private")
            ? "private"
            : mods.includes("protected")
              ? "protected"
              : "public",
          startLine: range.startLine,
          endLine: range.endLine,
          startColumn: begin.character + 1,
          endColumn: end.character + 1,
          parentSymbolUid: null,
          parentSymbolKey: parent ? symbolKey(parent) : null,
          decorators: ts.canHaveDecorators(node)
            ? (ts.getDecorators(node) ?? []).map((d) => d.getText(source))
            : [],
          modifiers: [
            ...mods,
            ...(fn && "asteriskToken" in fn && fn.asteriskToken
              ? ["generator"]
              : []),
          ],
          docComment: doc,
          sourceHash: contentHash!,
          parserVersion: AST_VERSION,
          scannedAt: now,
          analysisStatus: "resolved",
          evidence: evidence(node),
          fingerprint: hash(
            body
              ? ts
                  .createPrinter({ removeComments: true })
                  .printNode(ts.EmitHint.Unspecified, body, source!)
              : node.getText(source).replace(name, "$declaration"),
          ),
          declarationAnchor: hash(
            JSON.stringify([
              kind,
              qualifiedName,
              params,
              fn?.type?.getText(source) ?? null,
            ]),
          ),
        };
        symbols.push(draft);
        records.set(node, draft);
        return draft;
      }
      if (source && diagnostics.length === 0) {
        const module = add(source, "$file", "module", null);
        const walk = (node: ts.Node, parent: SymbolDraft) => {
          let decl: SymbolDraft | undefined;
          if (ts.isFunctionDeclaration(node))
            decl = add(node, node.name?.text ?? "default", "function", parent);
          else if (ts.isClassDeclaration(node))
            decl = add(node, node.name?.text ?? "default", "class", parent);
          else if (ts.isInterfaceDeclaration(node))
            decl = add(node, node.name.text, "interface", parent);
          else if (ts.isTypeAliasDeclaration(node))
            decl = add(node, node.name.text, "type", parent);
          else if (ts.isConstructorDeclaration(node))
            decl = add(node, "constructor", "constructor", parent);
          else if (ts.isMethodDeclaration(node))
            decl = add(node, node.name.getText(source), "method", parent);
          else if (
            ts.isExportAssignment(node) &&
            !node.isExportEquals &&
            (ts.isArrowFunction(node.expression) ||
              ts.isFunctionExpression(node.expression))
          )
            decl = add(node.expression, "default", "function", parent);
          else if (
            ts.isFunctionExpression(node) &&
            ts.isBinaryExpression(node.parent) &&
            ts.isPropertyAccessExpression(node.parent.left)
          )
            decl = add(
              node,
              node.name?.text ?? node.parent.left.name.text,
              "function",
              parent,
            );
          else if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) ||
              ts.isFunctionExpression(node.initializer)) &&
            ts.isIdentifier(node.name)
          ) {
            decl = add(node.initializer, node.name.text, "function", parent);
            records.set(node, decl);
            const statement = node.parent.parent;
            if (
              ts.isVariableStatement(statement) &&
              ts
                .getModifiers(statement)
                ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
            )
              decl.exported = true;
          }
          ts.forEachChild(node, (n) => walk(n, decl ?? parent));
        };
        ts.forEachChild(source, (n) => walk(n, module));
      }
      files.push({
        path,
        source,
        filePath,
        language,
        contentHash,
        parserVersion: AST_VERSION,
        configVersion: hash(JSON.stringify(options)),
        scannedAt: now,
        projectId,
        moduleId: filePath.split("/")[0] ?? "root",
        status: errors.has(path)
          ? ((errors.get(path)?.includes("limit")
              ? "unsupported"
              : "unavailable") as "unsupported" | "unavailable")
          : diagnostics.length
            ? ("stale" as const)
            : ("fresh" as "fresh" | "partial"),
        diagnostics,
        symbols,
        relations,
      });
    }
    for (const file of files) {
      const seen = new Map<string, number>();
      for (const symbol of file.symbols) {
        const key = symbolKey(symbol);
        const count = seen.get(key) ?? 0;
        seen.set(key, count + 1);
        if (count) {
          symbol.overload += `:duplicate-${count}`;
          symbol.declarationAnchor = undefined;
          file.status = "partial";
          file.diagnostics.push({
            code: "ambiguous-declaration",
            message:
              "duplicate lexical declaration key; provisional symbols only",
            severity: "error",
            filePath: file.filePath,
            occurredAt: now,
          });
        }
      }
    }
    const lookup = (node: ts.Node): SymbolDraft | undefined => {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      const ds = symbol?.declarations ?? [];
      const targets = ds
        .map((d) => records.get(d))
        .filter((s): s is SymbolDraft => !!s);
      return (
        targets.find((s) => s.overload.endsWith(":body")) ??
        (targets.length === 1 ? targets[0] : undefined)
      );
    };
    for (const f of files) {
      if (!f.source || f.status !== "fresh") continue;
      const source = f.source;
      const evidence = (n: ts.Node) => [
        {
          projectId,
          filePath: f.filePath,
          startLine:
            source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1,
          endLine: source.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
          sourceHash: f.contentHash!,
          parserVersion: AST_VERSION,
          strength: "observed" as const,
        },
      ];
      for (const symbol of f.symbols.filter(
        (s) => s.exported && s.kind !== "module",
      ))
        f.relations.push({
          kind: "exports",
          sourceKey: symbolKey(f.symbols[0]!),
          targetKey: symbolKey(symbol),
          strength: "resolved",
          evidence: symbol.evidence,
        });
      const visit = (n: ts.Node, owner: SymbolDraft) => {
        const current = records.get(n) ?? owner;
        if (
          ts.isCallExpression(n) &&
          n.arguments[0] &&
          ts.isStringLiteral(n.arguments[0]) &&
          (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(n.expression) && n.expression.text === "require"))
        ) {
          const resolved = ts.resolveModuleName(
            n.arguments[0].text,
            source.fileName,
            options,
            host,
          ).resolvedModule;
          const target = resolved
            ? records.get(program.getSourceFile(resolved.resolvedFileName)!)
            : undefined;
          f.relations.push({
            kind: "imports",
            sourceKey: symbolKey(current),
            targetKey: target ? symbolKey(target) : null,
            strength: target ? "resolved" : "observed",
            evidence: evidence(n),
          });
        } else if (ts.isCallExpression(n)) {
          const staticProperty =
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) &&
            !!(
              (checker.getSymbolAtLocation(n.expression.expression)?.flags ??
                0) & ts.SymbolFlags.Class
            );
          const target =
            ts.isIdentifier(n.expression) || staticProperty
              ? lookup(n.expression)
              : undefined;
          f.relations.push({
            kind: target ? "calls" : "unresolved_reference",
            sourceKey: symbolKey(current),
            targetKey: target ? symbolKey(target) : null,
            strength: target ? "resolved" : "observed",
            evidence: evidence(n),
          });
        }
        if (
          (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
          n.moduleSpecifier
        ) {
          const target = lookup(n.moduleSpecifier);
          f.relations.push({
            kind: ts.isImportDeclaration(n) ? "imports" : "exports",
            sourceKey: symbolKey(current),
            targetKey: target ? symbolKey(target) : null,
            strength: target ? "resolved" : "observed",
            evidence: evidence(n),
          });
        }
        ts.forEachChild(n, (child) => visit(child, current));
      };
      visit(source, f.symbols[0]!);
    }
    for (const key of this.cache.keys())
      if (!texts.has(key)) this.cache.delete(key);
    return {
      updates: files.map(({ path: _path, source: _source, ...f }) => f),
      parseMs,
      cachedFiles,
    };
  }
}
