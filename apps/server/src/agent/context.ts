/** Shared context builders for agent-facing output (used by cli.ts). */
export interface ContextModuleSummary {
  id: string;
  label: string;
  layer: string;
  impl: string;
  workflow: string;
}

export function summarize(modules: Array<ContextModuleSummary>): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const m of modules) tally[m.impl] = (tally[m.impl] ?? 0) + 1;
  return tally;
}
