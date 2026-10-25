import { useEffect, useRef, useState } from 'react';
import { useStore, sendEditingToPeers } from '../store.js';
import { IMPLEMENTATION_META, WORKFLOW_META, timeAgo } from './statusMeta.js';
import type { Evidence } from '@archsync/contracts';

const SOURCE_LABEL: Record<Evidence['source'], string> = {
  yaml: '规划配置',
  'git-tree': 'Git 基线',
  'github-issue': 'Issue',
  'github-pr': 'Pull Request',
  'github-check': 'CI 检查',
  'manual-acceptance': '人工验收',
  'local-watch': '本地监听',
  'demo-fixture': '演示数据',
};

export function DetailsDrawer() {
  const selection = useStore((s) => s.selection);
  const detail = useStore((s) => s.moduleDetail);
  const loading = useStore((s) => s.detailLoading);
  const snapshot = useStore((s) => s.snapshot);
  const participants = useStore((s) => s.participants);
  const select = useStore((s) => s.select);
  const saveAnnotation = useStore((s) => s.saveAnnotation);
  const conflict = useStore((s) => s.annotationConflict);
  const dismissConflict = useStore((s) => s.dismissConflict);
  const annotationWrite = useStore((s) => s.capabilities.annotationWrite);

  const [draft, setDraft] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const detailRevision = useRef<number>(-1);

  useEffect(() => {
    if (detail && detail.annotation.revision !== detailRevision.current) {
      detailRevision.current = detail.annotation.revision;
      setDraft(detail.annotation.text);
    }
  }, [detail]);

  const remoteEditing = [...participants.values()].filter(
    (p) => p.editingField === 'annotation' && p.selectedModuleId === selection,
  );

  if (!selection) return null;
  const module =
    detail ??
    snapshot?.modules.find((m) => m.id === selection) ??
    null;

  return (
    <aside className="drawer" aria-label="模块详情">
      <div className="drawer-head">
        <div>
          <h2>{module?.label ?? selection}</h2>
          <code className="module-id">{selection}</code>
        </div>
        <button className="close-btn" onClick={() => void select(null)} aria-label="关闭详情">×</button>
      </div>

      {loading && !detail && <div className="drawer-loading">加载中…</div>}
      {!module && !loading && <div className="drawer-loading">模块不存在于当前快照</div>}

      {module && (
        <>
          <div className="drawer-chips">
            <span className="chip chip-workflow" style={{ ['--chip' as string]: WORKFLOW_META[module.workflow].color }}>
              任务 · {WORKFLOW_META[module.workflow].label}
            </span>
            <span className="chip chip-impl" style={{ ['--chip' as string]: IMPLEMENTATION_META[module.implementation].color }}>
              实现 · {IMPLEMENTATION_META[module.implementation].label}
            </span>
          </div>

          {module.description && <p className="drawer-desc">{module.description}</p>}

          <Section title="人员">
            <div className="person-row">
              <span className="person-cat">负责人 owners</span>
              <span className="persons">{module.owners.length > 0 ? module.owners.join(', ') : '未指定'}</span>
            </div>
            <div className="person-row">
              <span className="person-cat">执行者 assignees</span>
              <span className="persons">{module.assignees.length > 0 ? module.assignees.join(', ') : '无'}</span>
            </div>
            <div className="person-row">
              <span className="person-cat">贡献者 contributors</span>
              <span className="persons">{module.contributors.length > 0 ? module.contributors.join(', ') : '无'}</span>
            </div>
          </Section>

          <Section title="依赖关系（规划）">
            <div className="dep-row">
              <span className="dep-cat">上游（依赖）</span>
              <div className="dep-chips">
                {module.plannedDependsOn.length === 0 && <span className="muted">无</span>}
                {module.plannedDependsOn.map((id) => (
                  <button key={id} className="dep-chip" onClick={() => void select(id)}>← {id}</button>
                ))}
              </div>
            </div>
            <div className="dep-row">
              <span className="dep-cat">下游（被依赖）</span>
              <div className="dep-chips">
                {module.dependedOnBy.length === 0 && <span className="muted">无</span>}
                {module.dependedOnBy.map((id) => (
                  <button key={id} className="dep-chip" onClick={() => void select(id)}>{id} →</button>
                ))}
              </div>
            </div>
            <p className="hint">依赖为规划边；本版本未做调用链分析（dependencyAnalysis: not_supported），不绘制“已验证”调用。</p>
          </Section>

          <Section title={`代码文件（工作区 ${module.matchedWorkspacePaths.length} · 基线 ${module.matchedBaselinePaths.length}）`}>
            <ul className="file-list">
              {module.plannedPaths.map((p) => (
                <li key={`plan-${p}`} className="file planned">{p} <span className="tag">规划</span></li>
              ))}
              {module.matchedWorkspacePaths
                .filter((p) => !module.plannedPaths.includes(p))
                .map((p) => (
                  <li key={`ws-${p}`} className="file">{p} <span className="tag ws">实际</span></li>
                ))}
            </ul>
            {module.overlayChanges.length > 0 && (
              <div className="overlay-box">
                <div className="overlay-title">本机未提交变更（仅本地视图，不代表主线）</div>
                <ul className="file-list">
                  {module.overlayChanges.map((c) => (
                    <li key={c.path} className={`file change-${c.kind}`}>
                      {c.kind === 'added' ? '＋' : c.kind === 'deleted' ? '－' : '＊'} {c.path}
                      {c.untracked && <span className="tag">未跟踪</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <Section title="协作任务">
            {snapshot?.githubDemo && (
              <p className="demo-note">以下 Issue / PR 来自演示数据 fixture，非真实 GitHub 仓库。</p>
            )}
            <div className="task-chips">
              {module.issueNumbers.length === 0 && module.pullRequestNumbers.length === 0 && (
                <span className="muted">暂无关联任务</span>
              )}
              {module.issueNumbers.map((n) => {
                const ev = module.evidence.find((e) => e.source === 'github-issue' && e.ref.startsWith(`#${n}`));
                return (
                  <span key={`i-${n}`} className="task-chip issue" title={ev?.ref}>
                    #{n}
                    {ev?.details?.state === 'closed' ? ' ✓' : ''}
                  </span>
                );
              })}
              {module.pullRequestNumbers.map((n) => {
                const ev = module.evidence.find((e) => e.source === 'github-pr' && e.ref.startsWith(`PR #${n}`));
                const details = ev?.details ?? {};
                return (
                  <span key={`p-${n}`} className="task-chip pr" title={ev?.ref}>
                    PR#{n}
                    {details.draft ? ' 草稿' : details.merged ? ' 已合并' : details.state === 'open' ? ' 开放' : ' 已关闭'}
                  </span>
                );
              })}
            </div>
          </Section>

          <Section title={`协作备注${detail ? ` · 修订 ${detail.annotation.revision}` : ''}`}>
            {remoteEditing.length > 0 && (
              <div className="editing-note">
                {remoteEditing.map((p) => (
                  <span key={p.sessionId}><i style={{ background: p.color }} /> {p.name} 正在编辑此备注…</span>
                ))}
              </div>
            )}
            {conflict && (
              <div className="conflict-note">
                ⚠ {conflict}
                <button onClick={dismissConflict}>知道了</button>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              placeholder={annotationWrite
                ? '记录架构备注（所有成员可见，乐观锁保护并发编辑）…'
                : '静态模式下备注为只读；启动本地服务模式（pnpm dev）后可编辑。'}
              maxLength={2000}
              disabled={!annotationWrite}
              onFocus={() => sendEditingToPeers('annotation')}
              onBlur={() => sendEditingToPeers(null)}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="annotation-foot">
              {detail?.annotation.updatedBy && (
                <span className="muted">
                  {detail.annotation.updatedBy} 更新于 {timeAgo(detail.annotation.updatedAt)}
                </span>
              )}
              <button
                className="save-btn"
                disabled={!detail || !annotationWrite}
                title={annotationWrite ? '保存备注' : '静态模式下备注不可编辑'}
                onClick={async () => {
                  if (!detail) return;
                  const ok = await saveAnnotation(module.id, draft, detail.annotation.revision);
                  if (ok) {
                    setSavedFlash(true);
                    setTimeout(() => setSavedFlash(false), 1500);
                  }
                }}
              >
                {savedFlash ? '✓ 已保存' : '保存备注'}
              </button>
            </div>
          </Section>

          <Section title="证据链">
            <ul className="evidence-list">
              {module.evidence.map((e, i) => (
                <li key={i} className="evidence">
                  <span className={`ev-src ${e.demo ? 'demo' : ''}`}>{SOURCE_LABEL[e.source]}{e.demo ? '·DEMO' : ''}</span>
                  <span className="ev-ref" title={e.ref}>{e.ref}</span>
                  <span className="ev-time">{timeAgo(e.observedAt)}</span>
                </li>
              ))}
            </ul>
          </Section>

          {module.warnings.length > 0 && (
            <Section title="警告">
              <ul className="warning-list">
                {module.warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="drawer-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}
