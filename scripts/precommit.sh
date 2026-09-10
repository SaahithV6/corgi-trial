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

# Editor scratch files must never be staged. This exists because a Kate swap
# file for the gitignored secrets scratch pad was committed: the ignore rule
# matched the document but not the artifacts an editor derives from it.
if git diff --cached --name-only --diff-filter=d | grep -qE '(\.swp|\.swo|~|\.kate-swp|\.orig|\.rej)$|(^|/)\.#'; then
  echo "--- offending staged files:" >&2
  git diff --cached --name-only --diff-filter=d | grep -E '(\.swp|\.swo|~|\.kate-swp|\.orig|\.rej)$|(^|/)\.#' >&2
  fail "an editor scratch file is staged. These can mirror the contents of files you never meant to commit."
fi

# Scan the WHOLE tree for credential shapes, not just the staged diff.
#
# The staged-diff scan added in 007 missed two real credentials that had
# already been committed in research/ NOTES files: a Plaid access token and a
# whsec_ captured from a live API response. They were written by research
# workers pasting real responses into their notes, and no diff scan after the
# fact would ever look at them again.
#
# Uses grep -a. src/lib/webhooks/inbox.ts contains a NUL byte, which makes
# plain grep treat it as binary and SKIP it silently — a secret scanner with a
# blind spot is worse than none, because it reports clean.
LEAK_RE='(access-(sandbox|development|production)-[a-f0-9]{8}-|whsec_[A-Za-z0-9+/]{20,}|sk_live_|npg_[A-Za-z0-9]{16,}|access-token-[a-f0-9]{8}-)'
# The published Standard Webhooks test vector is documentation, not a secret.
KNOWN_PUBLIC='whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
scan_files() {
  git ls-files | grep -vFxf .secretscanignore 2>/dev/null || git ls-files
}
if scan_files | while read -r f; do
         grep -aoE "$LEAK_RE[A-Za-z0-9+/_-]*" "$f" | grep -v "$KNOWN_PUBLIC" | grep -q . && echo "$f"
       done | grep -q .; then
  echo "--- files containing credential-shaped strings:" >&2
  scan_files | while read -r f; do
    grep -aoE "$LEAK_RE[A-Za-z0-9+/_-]*" "$f" | grep -v "$KNOWN_PUBLIC" | head -2 | sed "s|^|  $f: |" >&2
  done
  fail "a TRACKED file contains a credential-shaped string. Redact and rotate."
fi

echo "typecheck..." && pnpm run --silent typecheck || fail "typecheck"
echo "lint..."      && pnpm run --silent lint      || fail "lint"
echo "test..."      && pnpm run --silent test      >/dev/null 2>&1 || fail "tests"
echo "GATE GREEN"
