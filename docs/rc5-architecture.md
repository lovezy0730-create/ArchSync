# RC5 architecture model (post-trial fix)

This document records the model introduced after the real QQAgent trial showed
that the workbench had degraded into a folder browser and that the planned view
could hang on "正在加载快照…".

## One projection, five layers of facts

```
Source facts      AST / Python index in SQLite: files, symbols, relations
Architecture      systems → modules → files → symbols (+ discovery evidence)
Planning          .archsync/project.yaml modules, planned dependencies, views
Collaboration     GitHub PRs / issues / checks (never blocks local structure)
View projection   system / module / file / symbol graphs and planned-vs-actual
```

`GET /api/v1/projects/:id/architecture?level=…` returns one node/edge contract
for every level. Edges keep their evidence kind:

| kind | meaning |
| --- | --- |
| `planned` | declared in project.yaml, no code evidence |
| `observed` | seen in code but the target is not a symbol |
| `resolved` | resolved to a concrete symbol/file by the scanner |
| `inferred` | structural inference, not a call fact |
| `unresolved` | dynamic call / external dependency the scanner could not resolve |
| `stale` | one endpoint is not fresh in the index |

Nothing in the UI promotes `inferred`/`unresolved` edges to `resolved`.

## Module discovery without YAML

`apps/server/src/architecture/discovery.ts` replaces "top-level directory =
module" with evidence-based boundaries:

1. workspace package (`package.json` with a name) — high confidence;
2. Python package (`__init__.py`) — high confidence;
3. directory cluster only where no package boundary exists — medium;
4. fallback module for files that no boundary covers — low/medium.

Top-level directories become **systems** (navigation groups). Every source file
is assigned to exactly one leaf module. Labels are package names or relative
paths; no business responsibility is invented. Confidence and the evidence
strings are stored on the module config and shown in the UI.

User preferences (moves, renames, hidden modules) are written to
`<data dir>/architecture-preferences/<projectId>.json`, never into the scanned
repository.

## Snapshot availability

- `GET /snapshot` serves an existing snapshot immediately.
- If none exists it schedules a rebuild, waits at most `SNAPSHOT_WAIT_MS`
  (default 1200 ms), then returns `503 snapshot_pending` with the job id.
- A failed rebuild returns `503 snapshot_failed` with the concrete error.
- `GET /snapshot/status` is the cheap polling endpoint; the client never
  re-issues `/snapshot` while a first scan is building.
- Team data is fetched independently (`Promise.allSettled`); a team or GitHub
  failure cannot block the local architecture graph.
- The client keeps the last good snapshot per project, marks it `stale` when a
  refresh fails, and offers a retry that performs a real request.

## Four-level workbench

- system: systems + top-level modules, aggregated resolved edges;
- module: sub-modules + files, cross-module dependencies;
- file: file import/call graph;
- symbol: declarations and call graph, including explicit unresolved nodes.

The left tree, breadcrumbs, search/filter, graph/list toggle, file-dependency vs
symbol-call sub-view and the right evidence/source pane share the same
selection. Presentation mode survives view switches and restarts.

## Startup, crash recovery and old data

- The agent listens **before** scanning; `/healthz` reports `phase`,
  `listenMs`, restored project count and background progress.
- The Electron main process loads a local startup page immediately, then
  navigates to the workbench when `/healthz` answers. Failures (missing agent,
  page load failure, renderer crash, agent exit) show that page with a
  concrete reason, the log directory and a retry button.
- Persisted indexes from older discovery strategies are re-mapped by path
  without re-parsing source files, and the new snapshot is published in the
  background.
- `StateStore` migrates interrupted jobs and validates old snapshots; an
  incompatible snapshot is dropped and rebuilt instead of crashing the UI.
- Watchers are source-aware (indexed directories only, per-root native
  watches) and rebuilds are coalesced, so a 39k-file repository no longer
  starves the server.

## Real-repository acceptance

CI uses a fixed structural fixture (`MaiBot` / `Research` / `Scripts` with
workspace and Python packages). It is **not** evidence about a user's QQAgent
checkout. To verify a real repository locally, read-only:

```powershell
node scripts/rc5-architecture-acceptance.mjs --repo D:\path\to\QQAgent --out .\acceptance-evidence
```

The script launches the packaged app with an isolated data directory, registers
the repository through the GUI, and checks the index, system/module/file/symbol
graphs, source evidence and the planned view. It writes screenshots and
`acceptance-report.json`; it never writes to the repository.
