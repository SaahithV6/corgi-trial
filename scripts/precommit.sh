#!/usr/bin/env bash
# Refuse to commit a broken tree.
#
# This exists because of a real mistake: `git add -A` was run while parallel
# workers were mid-write, which committed half-finished files and turned CI
# red on main at hour two. Committing is now gated on the same checks CI runs,
# so the gate fails locally in ten seconds instead of remotely in ten minutes.
set -euo pipefail
cd "$(dirname "$0")/.."

if git status --porcelain | grep -qE '^\?\?\s+\.env$|^\s*[AM]\s+\.env$'; then
  echo "REFUSING: .env is staged or untracked-and-about-to-be-added."; exit 1
fi
if git ls-files | grep -qE '^\.env$'; then
  echo "REFUSING: .env is tracked by git. Secrets must never be committed."; exit 1
fi

echo "typecheck..."; pnpm -s typecheck
echo "lint...";      pnpm -s lint
echo "test...";      pnpm -s test --silent 2>&1 | tail -4
echo "gate green"
