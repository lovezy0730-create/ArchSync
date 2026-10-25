import { useMemo } from 'react';
import { useStore } from '@xyflow/react';
import { useStore as useAppStore } from '../store.js';

/**
 * Remote participant cursors, rendered in canvas coordinates and transformed
 * through the live React Flow viewport (position = flow * zoom + pan).
 */
export function RemoteCursors() {
  const participants = useAppStore((s) => s.participants);
  const transform = useStore((s) => s.transform);
  const [x, y, zoom] = transform;

  const cursors = useMemo(
    () =>
      [...participants.values()]
        .filter((p) => p.cursor !== null)
        .map((p) => ({
          sessionId: p.sessionId,
          name: p.name,
          color: p.color,
          left: p.cursor!.x * zoom + x,
          top: p.cursor!.y * zoom + y,
        })),
    [participants, x, y, zoom],
  );

  if (cursors.length === 0) return null;
  return (
    <div className="remote-cursors">
      {cursors.map((c) => (
        <div
          key={c.sessionId}
          className="remote-cursor"
          style={{ left: c.left, top: c.top, ['--c' as string]: c.color }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill={c.color} stroke="#0d1117" strokeWidth="1">
            <path d="M2 2 L2 15 L6 11 L9 17 L11.5 15.8 L8.6 10 L14 9.5 Z" />
          </svg>
          <span className="cursor-tag">{c.name}</span>
        </div>
      ))}
    </div>
  );
}
