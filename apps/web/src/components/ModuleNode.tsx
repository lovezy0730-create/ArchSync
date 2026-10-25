import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ModuleState, PresenceParticipant } from '@archsync/contracts';
import { IMPLEMENTATION_META, WORKFLOW_META } from './statusMeta.js';

export interface ModuleNodeData extends Record<string, unknown> {
  module: ModuleState;
  layerLabel: string;
  layerColor: string;
  dimmed: boolean;
  related: boolean;
  selectingParticipants: PresenceParticipant[];
}

export type ModuleFlowNode = Node<ModuleNodeData, 'module'>;

function ModuleNodeInner({ data, selected }: NodeProps<ModuleFlowNode>) {
  const { module, layerColor, dimmed, related, selectingParticipants } = data;
  const wf = WORKFLOW_META[module.workflow];
  const impl = IMPLEMENTATION_META[module.implementation];
  const fileCount = module.matchedWorkspacePaths.length;
  const overlayCount = module.overlayChanges.length;

  return (
    <div
      className={`module-node ${dimmed ? 'dimmed' : ''} ${related ? 'related' : ''} ${selected ? 'selected' : ''} impl-${module.implementation}`}
      style={{ ['--layer-color' as string]: layerColor }}
    >
      <Handle type="target" position={Position.Left} className="handle" />
      <Handle type="source" position={Position.Right} className="handle" />
      <div className="node-accent" />
      <div className="node-title-row">
        <span className="node-label" title={module.id}>{module.label}</span>
        {module.owners.slice(0, 2).map((owner) => (
          <span key={owner} className="owner-chip" title={`负责人 ${owner}`}>
            {owner.slice(0, 2).toUpperCase()}
          </span>
        ))}
      </div>
      <div className="node-chips">
        <span className="chip chip-workflow" style={{ ['--chip' as string]: wf.color }}>
          {wf.label}
        </span>
        <span className="chip chip-impl" style={{ ['--chip' as string]: impl.color }}>
          {impl.label}
        </span>
      </div>
      <div className="node-footer">
        <span className={`meta ${fileCount === 0 ? 'zero' : ''}`} title="匹配到的文件数（本地工作区）">
          ⬡ {fileCount} 文件
        </span>
        {overlayCount > 0 && (
          <span className="meta warn" title="本机未提交变更（仅本地视图）">
            ⚠ {overlayCount} 未提交
          </span>
        )}
        {module.issueNumbers.length > 0 && (
          <span className="meta" title="关联 Issue">☺ {module.issueNumbers.length}</span>
        )}
        {module.pullRequestNumbers.length > 0 && (
          <span className="meta" title="关联 PR">⑂ {module.pullRequestNumbers.length}</span>
        )}
      </div>
      {selectingParticipants.length > 0 && (
        <div className="node-presence">
          {selectingParticipants.map((p) => (
            <span key={p.sessionId} className="presence-dot" style={{ background: p.color }} title={`${p.name} 正在查看`}>
              {p.name.slice(0, 1)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export const ModuleNodeView = memo(ModuleNodeInner);
