/**
 * Parse and validate optional `.archsync/views.yaml` presentation plans.
 *
 * Views are deliberately separate from project.yaml: they decide how existing
 * modules are grouped and ordered, but never add, remove or rewrite modules or
 * dependencies. Invalid view files fall back to an automatically derived
 * layer view and never prevent the project from loading.
 */
import { parseDocument, YAMLParseError } from 'yaml';
import type { ConfigError, ProjectViewsFile } from '@archsync/contracts';
import { ProjectViewsFileSchema } from '@archsync/contracts';

export const MAX_VIEWS_BYTES = 256 * 1024;
export const MAX_VIEWS = 24;
export const MAX_VIEW_GROUPS = 60;

export interface ViewsParseResult {
  ok: boolean;
  file?: ProjectViewsFile & { defaultView: string };
  errors: ConfigError[];
  warnings: ConfigError[];
}

export function parseProjectViews(text: string, moduleIds: readonly string[]): ViewsParseResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigError[] = [];
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_VIEWS_BYTES) {
    return {
      ok: false,
      errors: [{
        path: '$',
        code: 'views_too_large',
        message: `视图配置 ${bytes} 字节，超过上限 ${MAX_VIEWS_BYTES} 字节`,
      }],
      warnings,
    };
  }

  let raw: unknown;
  try {
    const doc = parseDocument(text, { strict: false });
    if (doc.errors.length > 0) {
      for (const error of doc.errors) {
        errors.push({
          path: '$',
          code: 'yaml_syntax',
          message: `YAML 解析错误: ${error.message}`,
          line: error.linePos?.[0]?.line,
          column: error.linePos?.[0]?.col,
        });
      }
      return { ok: false, errors, warnings };
    }
    raw = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    const parseError = error as YAMLParseError;
    errors.push({
      path: '$',
      code: 'yaml_syntax',
      message: `YAML 语法错误: ${parseError.message}`,
      line: parseError.linePos?.[0]?.line,
      column: parseError.linePos?.[0]?.col,
    });
    return { ok: false, errors, warnings };
  }

  const parsed = ProjectViewsFileSchema.safeParse(raw);
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

  const file = parsed.data;
  const knownModules = new Set(moduleIds);
  const viewIds = new Set<string>();
  if (file.views.length > MAX_VIEWS) {
    errors.push({
      path: 'views',
      code: 'too_many_views',
      message: `视图数量 ${file.views.length} 超过上限 ${MAX_VIEWS}`,
    });
  }

  for (const [viewIndex, view] of file.views.entries()) {
    const viewPath = `views[${viewIndex}] (${view.id})`;
    if (viewIds.has(view.id)) {
      errors.push({
        path: `${viewPath}.id`,
        code: 'duplicate_view',
        message: `${viewPath}: 视图 ID 重复`,
      });
    }
    viewIds.add(view.id);
    if (view.groups.length > MAX_VIEW_GROUPS) {
      errors.push({
        path: `${viewPath}.groups`,
        code: 'too_many_groups',
        message: `${viewPath}: 分组数量 ${view.groups.length} 超过上限 ${MAX_VIEW_GROUPS}`,
      });
    }

    const groupIds = new Set<string>();
    const orderValues = new Set<number>();
    const assigned = new Set<string>();
    for (const [groupIndex, group] of view.groups.entries()) {
      const groupPath = `${viewPath}.groups[${groupIndex}] (${group.id})`;
      if (groupIds.has(group.id)) {
        errors.push({
          path: `${groupPath}.id`,
          code: 'duplicate_view_group',
          message: `${groupPath}: 同一视图内分组 ID 重复`,
        });
      }
      groupIds.add(group.id);
      if (orderValues.has(group.order)) {
        errors.push({
          path: `${groupPath}.order`,
          code: 'duplicate_group_order',
          message: `${groupPath}: 同一视图内 order=${group.order} 重复`,
        });
      }
      orderValues.add(group.order);

      for (const [moduleIndex, moduleId] of group.moduleIds.entries()) {
        if (!knownModules.has(moduleId)) {
          errors.push({
            path: `${groupPath}.moduleIds[${moduleIndex}]`,
            code: 'unknown_view_module',
            message: `${groupPath}: 模块 "${moduleId}" 不存在于 project.yaml`,
          });
          continue;
        }
        if (assigned.has(moduleId)) {
          errors.push({
            path: `${groupPath}.moduleIds[${moduleIndex}]`,
            code: 'duplicate_view_module',
            message: `${groupPath}: 模块 "${moduleId}" 在同一视图中被重复分组`,
          });
        }
        assigned.add(moduleId);
      }
    }

    if (view.direction === 'TB' && view.groups.length > 4) {
      warnings.push({
        path: `${viewPath}.direction`,
        code: 'tall_tb_view',
        message: `${viewPath}: 纵向视图包含 ${view.groups.length} 个分组，Fit View 后可能缩小；建议使用 LR 或拆分为多个视图`,
      });
    }

    const missing = moduleIds.filter((id) => !assigned.has(id));
    if (missing.length > 0) {
      warnings.push({
        path: `${viewPath}.groups`,
        code: 'unassigned_view_modules',
        message: `${viewPath}: ${missing.length} 个模块未分组，将显示在“其他模块”中: ${missing.join(', ')}`,
      });
    }
  }

  const defaultView = file.defaultView ?? file.views[0]!.id;
  if (!viewIds.has(defaultView)) {
    errors.push({
      path: 'defaultView',
      code: 'unknown_default_view',
      message: `defaultView "${defaultView}" 不存在`,
    });
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    file: {
      ...file,
      defaultView,
      views: file.views.map((view) => ({
        ...view,
        groups: [...view.groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      })),
    },
    errors,
    warnings,
  };
}