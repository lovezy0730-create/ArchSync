import type { ModuleState } from '@archsync/contracts';

/** Transitive upstream (what the module depends on) and downstream sets. */
export function dependencyClosure(
  modules: Array<Pick<ModuleState, 'id' | 'plannedDependsOn'>>,
  startId: string,
): { upstream: Set<string>; downstream: Set<string> } {
  const byId = new Map(modules.map((m) => [m.id, m]));
  // derive reverse edges locally so correctness never depends on the
  // dependedOnBy field being populated by the caller
  const reverse = new Map<string, string[]>();
  for (const m of modules) {
    for (const dep of m.plannedDependsOn) {
      reverse.set(dep, [...(reverse.get(dep) ?? []), m.id]);
    }
  }

  const upstream = new Set<string>();
  const downstream = new Set<string>();

  const walk = (id: string, neighbors: (id: string) => string[], visited: Set<string>): void => {
    for (const next of neighbors(id)) {
      if (next === startId || visited.has(next)) continue;
      visited.add(next);
      walk(next, neighbors, visited);
    }
  };
  walk(startId, (id) => byId.get(id)?.plannedDependsOn ?? [], upstream);
  walk(startId, (id) => reverse.get(id) ?? [], downstream);
  return { upstream, downstream };
}

/** true when the edge lies on an upstream or downstream path of the selection */
export function isEdgeOnPath(
  edge: { source: string; target: string },
  selectedId: string,
  upstream: Set<string>,
  downstream: Set<string>,
): boolean {
  const upHit =
    upstream.has(edge.source) && (upstream.has(edge.target) || edge.target === selectedId);
  const downHit =
    (downstream.has(edge.source) || edge.source === selectedId) && downstream.has(edge.target);
  return upHit || downHit;
}
