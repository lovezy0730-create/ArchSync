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
reference). `docs/benchmarks/rc5-large-optimized.json` re-runs the identical
harness after the identity index and batch fast path: cold P95 2.25 s and
warm-rescan P95 2.13 s. `docs/benchmarks/rc5-watch-latency.json` measures the
path a user actually sees (save → watcher → rebuild → fresh index) at P50
3.88 s and P95 4.46 s, inside the 5 s target on this host; registration to a
ready index is 1.25 s against the 30 s first-scan target. Both benchmarks use
the same frozen 1000-file fixture and remain observational (this machine is
not the fixed reference). The watcher still performs a warm **full** rescan -
per-file incremental parsing is not implemented - and the UI/snapshot work
after the index update is not part of the watch number.

The Windows GUI E2E failure at `a[href$="/pull/11"]` was two defects, not an
environment problem. `page.waitForFunction` does not await async predicates
(the returned Promise is truthy), so every async gate in the script passed on
its first tick; the GitHub scenario opened the activity panel before the first
sync pass had written `pulls-state`. Separately, the registry GitHub route
returned HTTP 500 inside every sync pass because `sync-status` is stamped only
at the end of a pass while `pulls-state` lands mid-pass, and `fetchedAt: null`
fails `CollabDataSchema`. The script now polls through `page.evaluate`, the
route falls back to the cache write time, and the panel re-reads the registry
until the first live payload arrives.

`02fc2bc` passed CI plus the full Windows pipeline: unpacked, Portable and
installed Setup GUI E2E, with Portable/Setup EXE and evidence artifacts. One
earlier run failed only the Setup step with `-1073741819` (access violation)
after three seconds on runner image `20261021.278`; the identical commit
passed on `20261030.294`, so treat that as a runner-image flake and compare
the image version before chasing an installer regression.

Relevant command: `pnpm --filter @archsync/server exec vitest run test/live-code-index.test.ts test/registry.test.ts test/github-cache-window.test.ts`.

The RC5.1 trial regression is fixed. Repositories without YAML no longer become
three top-level folder cards: `architecture/discovery.ts` finds workspace
packages, Python packages and directory clusters, makes top-level directories
systems, and assigns every file to one leaf module. The snapshot's module
dependencies now come from resolved AST/Python imports and calls, and
`GET /architecture` serves system/module/file/symbol graphs whose edge kinds
distinguish planned, observed, resolved, inferred, unresolved and stale. See
`docs/rc5-architecture.md`.

The planned view no longer hangs: `/snapshot` waits a bounded time, then returns
`snapshot_pending`/`snapshot_failed` with a job id and reason; the client has
request timeouts, a snapshot state machine (loading/pending/stale/error/ready),
stale caching and a real retry. Team and GitHub failures cannot block the local
graph. `/resync` works without `.archsync/project.yaml`, Git HEAD is read
independently via `/git`, and the workbench polls `/code-index/status` instead
of transferring the full index every 2.5 s.

CI cannot read a user's local QQAgent checkout; the Windows E2E uses a fixed
structural fixture and the new
`scripts/rc5-architecture-acceptance.mjs --repo <path>` is the read-only local
acceptance path for the real repository. The fixture is not presented as
QQAgent evidence.

## RC5.1 startup / white-screen hotfix

The trial build `149bb77` (Portable `1.3.0-rc.5`) could show a white window for
minutes on a real Windows machine with four registered repositories. Root
causes, confirmed from the user's data and logs:

- `createServer` awaited a full rebuild of **every** registered project before
  `app.listen`. With QQAgent (39,506 workspace files, 87 indexed Python files,
  9.8 MB index) the HTTP server never became reachable within the 30 s window,
  so the main process fell back to an **unstyled white** data-URL error page.
- The Windows watcher polled every registered tree every 800 ms. On a 39k-file
  repository that starved the event loop so `scanProject` inside a rebuild did
  not finish for minutes (confirmed by disabling the watcher: rebuilds finished
  in ~200 ms–1.8 s).
- `codeIndex.files()` re-parsed the whole multi-megabyte index for the
  projection, the watcher, the old-module remap and the rebuild.
- `StateStore` did not serialize mutations and kept `running` jobs from a
  previous process forever.

Fixes:

- `app.listen` happens before any scan; background rebuilds are deferred 2 s,
  bounded to 2 concurrent projects, active project first, and never block the
  window. `/healthz` answers immediately with the startup phase.
- `StateStore.load` migrates old data: `running` jobs become explicit
  interrupted errors, missing fields get defaults, incompatible snapshots are
  dropped (the project rebuilds) and mutations are serialized.
- The watcher watches **only directories that contain indexed source files**
  (per-root native `fs.watch`, polling only when explicitly requested), filters
  runtime/log extensions, and rebuilds are coalesced per project.
- `CodeIndex` caches parsed files by an in-process version; the system graph
  renders from the architecture projection before the full index arrives.
- Electron shows a dark startup page immediately, then navigates to the app;
  `did-fail-load`, `render-process-gone`, `unresponsive`, agent exits and page
  timeouts are logged to `<userData>/logs/main.log` with a retry button.
- React has an Error Boundary plus global error records, snapshot schema
  validation, graph node/edge sanitization and selection fallback.
- Trial version is now `1.3.0-rc.6`; About/Diagnostics shows version, build SHA,
  agent/DB schema, data dir, startup timings and a copyable report.

`docs/benchmarks/rc5-startup-windows.json` (packaged app, 22-CPU Windows host,
2 projects, 1000 TS + 101 Python files, ~10k symbols): first window P95 449 ms,
app URL P95 1.31 s, interactive P95 1.36 s, first architecture graph P95 875 ms,
agent listen P95 73 ms, background scans P95 8.1 s. Targets (3 s window / 5 s
interactive) are met on this host; the numbers are observational.

Old-data upgrade was validated against a **copy of the user's real RC5 data**
(4 projects, 46 MB SQLite, 734 KB state): startup page shown, interactive in
~3.6 s, four projects restored, old module ids remapped immediately, new
discovered snapshot published ~6.2 s after launch. CI uses sanitized fixtures
(`test/startup.test.ts`) and never the user's data.

