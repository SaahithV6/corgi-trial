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
# --- EXACT: no staged line may contain a real value from .env -------------
#
# This is the check that actually protects the keys, and it replaced a proxy.
# The proxy was a shape rule, 0x + 64 hex, aimed at USDC_SENDER_PRIVATE_KEY.
# It worked until this repo started doing secp256k1 arithmetic, at which point
# the curve order, the field prime, both generator coordinates, every keccak
# vector and the published EIP-155 signature all matched it. A rule that fires
# on twenty-four innocent constants gets switched off by whoever is in a hurry,
# and then it protects nothing.
#
# Comparing against the literal values instead has no false positives at all,
# and it is strictly stronger for every secret this project actually holds: it
# catches a leaked key in ANY encoding position, prefix or not, hex or not.
if [ -f .env ]; then
  # Values only, quotes stripped, 16 chars or longer. Short values like "true"
  # would match half the tree.
  #
  # Not every value in .env is a secret. A wallet address, a token contract
  # address and a public RPC endpoint all live there, all exceed the length
  # floor, and all appear legitimately in documentation and scripts. Matching
  # on them would fire on every honest file that names the wallet the payout
  # sends from, which is exactly the noise that gets a gate disabled.
  #
  # So the classification is by KEY NAME, and the burden is the same as in
  # .secretscanignore: to add a pattern here you must show the value cannot
  # authenticate anything. Note what is deliberately NOT public: DATABASE_URL
  # and DIRECT_URL end in _URL and carry a password in the userinfo.
  PUBLIC_KEY_RE='(_ADDRESS|_RPC_URL|_CHAIN_ID|_BASE_URL|_WEBHOOK_URL|^NEXT_PUBLIC_)'
  SECRET_VALUES=$(grep -E '^[A-Z0-9_]+=.+' .env \
    | grep -vE "^[A-Z0-9_]*${PUBLIC_KEY_RE}[A-Z0-9_]*=" \
    | sed 's/^[A-Z0-9_]*=//' | sed 's/^"//; s/"$//' \
    | awk 'length($0) >= 16' | sort -u)
  if [ -n "$SECRET_VALUES" ]; then
    LEAKED=""
    for f in $(git diff --cached --name-only --diff-filter=d); do
      [ -f "$f" ] || continue
      case "$f" in scripts/precommit.sh) continue ;; esac
      if grep -aqFf <(printf '%s\n' "$SECRET_VALUES") "$f"; then LEAKED="$LEAKED $f"; fi
    done
    if [ -n "$LEAKED" ]; then
      echo "--- staged files containing a literal value from .env:$LEAKED" >&2
      # Deliberately does NOT print the matching line. A gate that echoes the
      # secret it caught puts it in a terminal scrollback and a CI log.
      fail "a staged file contains a real credential from .env."
    fi
  fi
fi

# --- SHAPE: provider key prefixes, which are unambiguous ------------------
#
# These carry their own namespace, so unlike bare hex they cannot collide with
# a mathematical constant. This file is excluded from its own scan: the pattern
# list contains the literal "sk_live_", so on its first run it flagged itself
# and blocked the commit that introduced it.
SECRET_RE='(npg_[A-Za-z0-9]{16,}|sk''_live_|whsec_[A-Za-z0-9]{16,})'
if git diff --cached -U0 -- . ':(exclude)scripts/precommit.sh' 2>/dev/null \
     | grep -qE "^\+.*${SECRET_RE}"; then
  echo "--- offending staged lines:" >&2
  git diff --cached -U0 -- . ':(exclude)scripts/precommit.sh' | grep -nE "^\+.*${SECRET_RE}" | head -3 >&2
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
