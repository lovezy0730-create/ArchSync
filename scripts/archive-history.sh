#!/usr/bin/env bash
# Archive versioned snapshot history to the `site-snapshots` branch.
#
# The branch is an ORPHAN, history-only repository: it never contains main's
# source tree. First run initializes it with `git init`; later runs clone it
# and replace history/ with the freshly generated version files.
#
# Usage: archive-history.sh <history-src-dir> <target-remote-url> [branch]
#   <history-src-dir>  directory containing <projectId>/{index.json,v*.json}
#   <target-remote-url>  git remote URL (https with token, or local path)
#   [branch]           defaults to site-snapshots
#
# Exit codes: 0 = pushed or unchanged; nonzero = push failed twice or bad input.
set -euo pipefail

HISTORY_SRC="${1:?usage: archive-history.sh <history-src-dir> <remote-url> [branch]}"
REMOTE_URL="${2:?missing remote url}"
BRANCH="${3:-site-snapshots}"

if [ ! -d "$HISTORY_SRC" ] || [ -z "$(ls -A "$HISTORY_SRC" 2>/dev/null)" ]; then
  echo "[archive] No history produced by build — nothing to archive."
  exit 0
fi

# Refuse to propagate corrupted history: every index.json must be valid JSON.
# The build pipeline already ran SnapshotSchema + secret scans; this is the
# last-line structural check before anything is pushed to the history branch.
if ! command -v node >/dev/null 2>&1; then
  echo "[archive] node 不可用，无法校验历史数据完整性" >&2
  exit 78
fi
for INDEX in "$HISTORY_SRC"/*/index.json; do
  [ -e "$INDEX" ] || continue
  if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$INDEX" 2>/dev/null; then
    echo "[archive] 历史数据损坏（非法 JSON）: $INDEX — 拒绝归档" >&2
    exit 65
  fi
done
echo "[archive] 历史数据结构校验通过。"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git config --global user.name "archsync-snapshot-bot"
git config --global user.email "actions@users.noreply.github.com"

push_history() {
  local repo_dir="$1"
  git -C "$repo_dir" add -A
  if git -C "$repo_dir" diff --cached --quiet; then
    echo "[archive] History unchanged — no commit needed."
    return 0
  fi
  git -C "$repo_dir" commit -m "chore(snapshots): archive snapshot versions [skip ci]"
  git -C "$repo_dir" push "$REMOTE_URL" "HEAD:$BRANCH"
}

if git ls-remote --heads "$REMOTE_URL" "$BRANCH" | grep -q "$BRANCH"; then
  echo "[archive] Branch exists — fetching and updating."
  git clone --depth 1 --single-branch --branch "$BRANCH" "$REMOTE_URL" "$WORK/repo"
  rm -rf "$WORK/repo/history"
  mkdir -p "$WORK/repo/history"
  cp -r "$HISTORY_SRC"/. "$WORK/repo/history/"
  if ! push_history "$WORK/repo"; then
    echo "[archive] Push rejected (concurrent update) — retrying once with a fresh clone."
    rm -rf "$WORK/repo"
    git clone --depth 1 --single-branch --branch "$BRANCH" "$REMOTE_URL" "$WORK/repo"
    rm -rf "$WORK/repo/history"
    mkdir -p "$WORK/repo/history"
    cp -r "$HISTORY_SRC"/. "$WORK/repo/history/"
    push_history "$WORK/repo"
  fi
else
  echo "[archive] Branch missing — initializing orphan history-only repository."
  git init -q --initial-branch="$BRANCH" "$WORK/repo"
  mkdir -p "$WORK/repo/history"
  cp -r "$HISTORY_SRC"/. "$WORK/repo/history/"
  push_history "$WORK/repo"
fi

echo "[archive] $BRANCH branch is up to date."
