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

Python WASM resources are copied into desktop packaging; local Portable/Setup
building was blocked by downloads timing out, while the unpacked GUI was
tested with a locally available Electron 35.7.5 runtime. Next: complete CI
for both EXEs, actual installer/portable E2E, diagnostics and remaining UI
and performance gates. The app is not yet ready for user trial.

Relevant command: `pnpm --filter @archsync/server exec vitest run test/live-code-index.test.ts test/registry.test.ts`.
