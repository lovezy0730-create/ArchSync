# ArchSync

ArchSync is a planned architecture visualization and multi-agent collaboration platform.

> **Current status:** planning / pre-implementation. This repository does not yet contain a working Web app, backend, or realtime sync service.

## Start here

- [Complete MVP construction plan](docs/CONSTRUCTION_PLAN.md) — architecture, schemas, endpoints, GitHub sync, realtime collaboration, roadmap and T01–T30 acceptance matrix.
- [Rules for coding agents](AGENTS.md) — required feature branches, atomic Conventional Commits, isolated worktrees and review gates.
- [Pull request template](.github/pull_request_template.md) — testing evidence and review checklist.

## Repository workflow

1. Branch from the newest `origin/main` for each task package (e.g., `feat/ARCH-002-config-contracts`).
2. Keep each commit independently reviewable; run applicable tests.
3. Open a PR to `main`, attach real verification evidence, and wait for review.
4. Do not merge or directly push feature work to `main`.

Development should begin at **ARCH-001**, after approval of the documentation PR.

Repository: https://github.com/lovezy0730-create/ArchSync
