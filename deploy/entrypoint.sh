#!/bin/sh
# Boot the KB Studio server: clone the KB repo into the data volume on first run, set a commit identity,
# then start the server. Idempotent — safe to run on every container start.
set -eu

: "${KB_REPO_DIR:=/data/kb-repo}"
: "${KB_DIR:=$KB_REPO_DIR}"       # repo root IS the KB (manifest.meta.yaml + topics/ + access.yaml)
: "${KB_WORKTREES_DIR:=/data/worktrees}"
export KB_REPO_DIR KB_DIR KB_WORKTREES_DIR

if [ ! -d "$KB_REPO_DIR/.git" ]; then
  echo "Cloning $KB_GITHUB_REPO into $KB_REPO_DIR …"
  # Token embedded in the remote so the server can fetch + push user branches for review.
  git clone "https://x-access-token:${KB_GITHUB_TOKEN}@github.com/${KB_GITHUB_REPO}.git" "$KB_REPO_DIR"
fi

# Identity for commits the server authors on a user's behalf where git needs a committer (merges, restores).
git -C "$KB_REPO_DIR" config user.email "${KB_GIT_EMAIL:-kb-studio@localhost}"
git -C "$KB_REPO_DIR" config user.name "${KB_GIT_NAME:-KB Studio}"
mkdir -p "$KB_WORKTREES_DIR"

exec pnpm exec tsx packages/studio/src/server.ts
