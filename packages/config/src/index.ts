/**
 * Parse and validate `.archsync/project.yaml` planning files.
 *
 * The YAML file is the single source of truth for *planning* facts. Dynamic
 * state (GitHub, scans) never writes back into it. Invalid configs are
 * rejected with located errors and never replace a previously good snapshot.
 */
import { parseDocument, YAMLParseError, type Document } from 'yaml';
import type {
  ConfigError,
  ConfigParseResult,
  ModuleConfigSchema,
  ProjectConfigFile,
} from '@archsync/contracts';
import { ProjectConfigFileSchema, MODULE_ID_PATTERN } from '@archsync/contracts';
import { z } from 'zod';

export const MAX_CONFIG_BYTES = 1024 * 1024; // 1 MiB
export const MAX_MODULES = 500;
export const MAX_LAYERS = 50;

type ModuleConfig = z.infer<typeof ModuleConfigSchema>;

/** Deterministic ordering: layers by (order, id), modules by (layer order, id). */
function normalizeOrder(config: ProjectConfigFile): ProjectConfigFile {
  const layerOrder = new Map(config.layers.map((l) => [l.id, l.order]));
  const layers = [...config.layers].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const modules = [...config.modules].sort(
    (a, b) =>
      (layerOrder.get(a.layer) ?? 0) - (layerOrder.get(b.layer) ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return { ...config, layers, modules };
}

function validatePathGlob(raw: string, path: string, errors: ConfigError[]): void {
  if (raw.length === 0) {
    errors.push({ path, code: 'path_empty', message: `${path}: 路径不能为空` });
    return;
  }
  if (raw.includes('\0')) {
    errors.push({ path, code: 'path_nul', message: `${path}: 路径包含 NUL 字符` });
    return;
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    errors.push({
      path,
      code: 'path_absolute',
      message: `${path}: 必须是相对仓库根的 POSIX 路径，不允许绝对路径 (${raw})`,
    });
    return;
  }
  if (raw.includes('\\')) {
    errors.push({
      path,
      code: 'path_backslash',
      message: `${path}: 路径必须使用 POSIX 分隔符 "/"，不允许 "\\" (${raw})`,
    });
    return;
  }
  const segments = raw.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      errors.push({
        path,
        code: 'path_escape',
        message: `${path}: 路径不允许包含 ".." (${raw})`,
      });
      return;
    }
    if (seg === '.' && segments.length > 1) {
      errors.push({
        path,
        code: 'path_dot_segment',
        message: `${path}: 路径不允许 "." 段 (${raw})`,
      });
      return;
    }
  }
}

function findCycles(config: ProjectConfigFile, warnings: ConfigError[]): void {
  const deps = new Map<string, string[]>();
  for (const m of config.modules) deps.set(m.id, m.plannedDependsOn);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const cycleStart = stack.indexOf(dep);
        const cycle = [...stack.slice(cycleStart), dep].join(' -> ');
        const key = [...stack.slice(cycleStart)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          warnings.push({
            path: `modules.${dep}.plannedDependsOn`,
            code: 'dependency_cycle',
            message: `检测到循环依赖: ${cycle}（允许但已标记）`,
          });
        }
      } else if (c === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const m of config.modules) {
    if ((color.get(m.id) ?? WHITE) === WHITE) visit(m.id);
  }
}

export function parseProjectConfig(text: string): ConfigParseResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigError[] = [];

  // TextEncoder instead of Buffer: this module also runs in the browser
  // (static-site YAML import preview).
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_CONFIG_BYTES) {
    errors.push({
      path: '$',
      code: 'config_too_large',
      message: `配置文件 ${bytes} 字节，超过上限 ${MAX_CONFIG_BYTES} 字节`,
    });
    return { ok: false, errors, warnings };
  }

  let doc: Document.Parsed;
  try {
    doc = parseDocument(text, { strict: false });
  } catch (err) {
    const e = err as YAMLParseError;
    errors.push({
      path: '$',
      code: 'yaml_syntax',
      message: `YAML 语法错误: ${e.message}`,
      line: e.linePos?.[0]?.line,
      column: e.linePos?.[0]?.col,
    });
    return { ok: false, errors, warnings };
  }
  const yamlErrors = doc.errors;
  if (yamlErrors.length > 0) {
    for (const e of yamlErrors) {
      errors.push({
        path: '$',
        code: 'yaml_syntax',
        message: `YAML 解析错误: ${e.message}`,
        line: e.linePos?.[0]?.line,
        column: e.linePos?.[0]?.col,
      });
    }
    return { ok: false, errors, warnings };
  }

  const raw: unknown = doc.toJS({ maxAliasCount: 100 });

  const parsed = ProjectConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        path: issue.path.join('.') || '$',
        code: issue.code,
        message: `${issue.path.join('.') || '$'}: ${issue.message}`,
      });
    }
    return { ok: false, errors, warnings };
  }

  const config = parsed.data;

  if (config.layers.length > MAX_LAYERS) {
    errors.push({
      path: 'layers',
      code: 'too_many_layers',
      message: `层数 ${config.layers.length} 超过上限 ${MAX_LAYERS}`,
    });
  }
  if (config.modules.length > MAX_MODULES) {
    errors.push({
      path: 'modules',
      code: 'too_many_modules',
      message: `模块数 ${config.modules.length} 超过上限 ${MAX_MODULES}`,
    });
  }

  const layerIds = new Set<string>();
  for (const layer of config.layers) {
    if (layerIds.has(layer.id)) {
      errors.push({
        path: `layers[id=${layer.id}]`,
        code: 'duplicate_layer',
        message: `层 ID 重复: ${layer.id}`,
      });
    }
    layerIds.add(layer.id);
  }

  const moduleIds = new Set<string>();
  for (const m of config.modules) {
    if (moduleIds.has(m.id)) {
      errors.push({
        path: `modules[id=${m.id}]`,
        code: 'duplicate_module',
        message: `模块 ID 重复: ${m.id}`,
      });
    }
    moduleIds.add(m.id);
  }

  for (const [index, m] of config.modules.entries()) {
    const base = `modules[${index}] (${m.id})`;
    if (!layerIds.has(m.layer)) {
      errors.push({
        path: `${base}.layer`,
        code: 'unknown_layer',
        message: `${base}: 引用了未定义的层 "${m.layer}"`,
      });
    }
    if (!MODULE_ID_PATTERN.test(m.id)) {
      errors.push({
        path: `${base}.id`,
        code: 'invalid_id',
        message: `${base}: ID 必须匹配 ${MODULE_ID_PATTERN}`,
      });
    }
    for (const [depIndex, dep] of m.plannedDependsOn.entries()) {
      if (dep === m.id) {
        errors.push({
          path: `${base}.plannedDependsOn[${depIndex}]`,
          code: 'self_dependency',
          message: `${base}: 不允许依赖自身`,
        });
      } else if (!moduleIds.has(dep)) {
        errors.push({
          path: `${base}.plannedDependsOn[${depIndex}]`,
          code: 'dangling_dependency',
          message: `${base}: 依赖目标 "${dep}" 不存在`,
        });
      }
    }
    for (const [pIndex, p] of m.paths.entries()) {
      validatePathGlob(p, `${base}.paths[${pIndex}]`, errors);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  // Cross-cutting checks that produce warnings only.
  findCycles(config, warnings);

  const seen = new Set<string>();
  const deduped = config.modules.map((m) => {
    const unique = [...new Set(m.plannedDependsOn)];
    for (const dep of m.plannedDependsOn) {
      const key = `${m.id}->${dep}`;
      if (seen.has(key)) {
        warnings.push({
          path: `modules[id=${m.id}].plannedDependsOn`,
          code: 'duplicate_edge',
          message: `重复依赖边 ${key} 已去重`,
        });
      }
      seen.add(key);
    }
    return { ...m, plannedDependsOn: unique };
  });

  return {
    ok: true,
    config: normalizeOrder({ ...config, modules: deduped }),
    errors,
    warnings,
  };
}

export type { ModuleConfig };
export { parseProjectViews, MAX_VIEWS_BYTES, MAX_VIEWS, MAX_VIEW_GROUPS } from './views.js';
export type { ViewsParseResult } from './views.js';
