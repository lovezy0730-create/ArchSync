import type { ImplementationState, WorkflowState } from '@archsync/contracts';

export const WORKFLOW_META: Record<WorkflowState, { label: string; color: string }> = {
  not_started: { label: '未开始', color: '#8b949e' },
  in_progress: { label: '开发中', color: '#58a6ff' },
  in_review: { label: '待审核', color: '#bc8cff' },
  blocked: { label: '已阻塞', color: '#f8514b' },
  done: { label: '已完成', color: '#3fb950' },
  unknown: { label: '未知', color: '#d29922' },
};

export const IMPLEMENTATION_META: Record<ImplementationState, { label: string; color: string }> = {
  not_detected: { label: '未检测到代码', color: '#8b949e' },
  detected_unverified: { label: '有代码·未验收', color: '#d29922' },
  verified: { label: '已验收', color: '#3fb950' },
  unknown: { label: '未知', color: '#6e7681' },
};

export function timeAgo(iso: string | null): string {
  if (!iso) return '从未';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '未知时间';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function githubSourceLabel(source: string, demo: boolean): { label: string; color: string } {
  if (source === 'live') return { label: 'GitHub 实时', color: '#3fb950' };
  if (source === 'demo') return { label: '演示数据', color: '#d29922' };
  return { label: 'GitHub 未接入', color: '#8b949e' };
}
