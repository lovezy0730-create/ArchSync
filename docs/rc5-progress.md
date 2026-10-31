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

Next: complete diagnostics and safe source retrieval, test stale and project
isolation through the server, then connect the actual four-level workspace.
The application still requires desktop packaging, GUI and packaged E2E work.

Relevant command: `pnpm --filter @archsync/server exec vitest run test/live-code-index.test.ts test/registry.test.ts`.
