# RC5 progress

Base before this work: `e3b4f3624b733d8cd34eb8b9e0de4a09c0092dc3`.
Current SHA: run `git rev-parse HEAD` in the RC5 worktree.

The registry accepts a local Git repository without YAML and builds explicitly
inferred in-memory path groups without writing to the repository. The server
rebuild queue runs both AST scanners and exposes their SQLite index at
`GET /api/v1/projects/:id/code-index`. Watcher events reload the project and
schedule another scan. A real mixed-language fixture covers registration,
indexing, a watched edit and restart. These are initial integration steps,
not a completed Phase B or a desktop acceptance result.
Unmatched files in configured projects are reported as unplanned observed
code instead of being assigned to a planned module. Repositories without a
first Git commit can be registered.

Read-only source retrieval checks the indexed path, resolves it inside the
project root and reports whether the content still matches the fresh index.
The source endpoint was added in `ba737be`. A watcher integration test also
checks fresh → stale → fresh and verifies that the cached UID survives.
The index response separates status counts and current versus historical
symbol counts; projects without a GitHub remote do not attempt live fetches.

As of `06836ef`, the code workspace reads the live index and supports module → file →
declaration navigation, source and evidence, filters and SQLite-persisted
selection. The Windows unpacked application passed a Playwright GUI test with
an isolated TS/Python repository, watched edit, UID and restart, plus the real
ArchSync scanner source. This is not Portable/Setup installer acceptance.
The selected project and declaration survive port changes; a missing project
is reported instead of silently switching to a different repository.
GitHub and local-scan errors are persisted separately; unsuccessful syncs do
not advance the last successful timestamp. HTTP 400/401/403/429 and
timeout/network failure classifications have regression tests.
The system view now draws module dependencies only from trusted static edges;
unplanned code is separated from the YAML plan and marked explicitly.

`45c9442` copies Python WASM and license resources into desktop packaging;
local Portable/Setup
building was blocked by downloads timing out, while the unpacked GUI was
tested with a locally available Electron 35.7.5 runtime. Next: complete CI
for both EXEs, actual installer/portable E2E, diagnostics and remaining UI
and performance gates. The app is not yet ready for user trial.
CI built both EXEs at `03402a6` and passed unpacked GUI E2E, but direct
Playwright attachment to the Portable wrapper timed out. A CDP-based launcher
was tested locally against an unpacked executable and needs Portable CI proof.
The later Windows run for `026208f` passed unpacked, Portable and installed
Setup GUI scenarios; later HEADs need their own CI result. The 1000-file real
AST benchmark can be reproduced with `pnpm exec tsx apps/server/src/large-ast-benchmark.ts --out <report.json>`;
its results are observational unless the machine matches the frozen reference.
The baseline 1000-file report contains 10 samples each: cold P95 11.39 s and
edit P95 13.16 s on a 22-logical-CPU / 32-GB Windows machine (not the fixed
reference). It exposed repeated per-file symbol-map construction; that work
has been removed and must be measured again before drawing any conclusion.

Relevant command: `pnpm --filter @archsync/server exec vitest run test/live-code-index.test.ts test/registry.test.ts`.
