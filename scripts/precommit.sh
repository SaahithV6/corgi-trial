#!/usr/bin/env bash
# Refuse to commit a broken tree. Run as:  scripts/precommit.sh && git commit ...
#
# Exists because of two real mistakes at hour two and hour three: committing
# and applying another worker's in-progress files. See DECISIONS 007 and 009.
#
# It exits non-zero on failure, and it must be chained with && so that a red
# gate actually stops the commit. A gate joined with ';' is decoration.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "GATE FAILED: $*" >&2; exit 1; }

git ls-files | grep -qE '^\.env$' && fail ".env is tracked by git. Secrets must never be committed."
git diff --cached --name-only | grep -qE '^\.env$' && fail ".env is staged."

# Any staged file carrying something that looks like a live credential.
#
# This file is excluded from its own scan. The pattern list contains the
# literal "sk_live_", so on its first run the scanner flagged itself and
# blocked the commit that introduced it. Funny, and also the correct
# behaviour for everything that is not this file.
SECRET_RE='(npg_[A-Za-z0-9]{16,}|sk''_live_|whsec_[A-Za-z0-9]{16,}|0x[a-fA-F0-9]{64})'
if git diff --cached -U0 -- . ':(exclude)scripts/precommit.sh' 2>/dev/null \
     | grep -qE "^\+.*${SECRET_RE}"; then
  echo "--- offending staged lines:" >&2
  git diff --cached -U0 -- . ':(exclude)scripts/precommit.sh' | grep -nE "^\+.*${SECRET_RE}" | cut -c1-160 >&2
  fail "a staged line looks like a live secret. Check the diff above."
fi

echo "typecheck..." && pnpm run --silent typecheck || fail "typecheck"
echo "lint..."      && pnpm run --silent lint      || fail "lint"
echo "test..."      && pnpm run --silent test      >/dev/null 2>&1 || fail "tests"
echo "GATE GREEN"
