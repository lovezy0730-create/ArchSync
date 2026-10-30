import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { ViewTone } from '@archsync/contracts';

export interface ViewGroupNodeData extends Record<string, unknown> {
  label: string;
  color: string;
  tone: ViewTone;
  count: number;
  description?: string;
}

export type ViewGroupFlowNode = Node<ViewGroupNodeData, 'view-group'>;

function ViewGroupNodeInner({ data }: NodeProps<ViewGroupFlowNode>) {
  return (
    <div
      className={`view-group-node view-group-${data.tone}`}
      style={{ ['--group-color' as string]: data.color }}
      aria-label={`${data.label}，${data.count} 个模块`}
    >
      <div className="view-group-head">
        <i />
        <strong>{data.label}</strong>
        <span>{data.count} 模块</span>
      </div>
      {data.description && <p>{data.description}</p>}
    </div>
  );
}

export const ViewGroupNodeView = memo(ViewGroupNodeInner);