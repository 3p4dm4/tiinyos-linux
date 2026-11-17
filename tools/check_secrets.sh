#!/usr/bin/env bash
# Fail-closed secrets scan over tracked files (CI + local pre-push).
# Patterns calibrated on what THIS repo must never contain: the device authKey
# (32 hex, lives in ~/.local/tiiny/config.json), device serials, JWT-ish
# tokens (Discord/etc.), private keys, credentials embedded in URLs.
# Exit 0 = clean, 1 = findings (file:line printed, content NOT echoed).
set -uo pipefail

fail=0
scan() {
  local label="$1" regex="$2"
  # git grep on tracked files only; -I skips binaries; never print the match
  local hits
  hits=$(git grep -nIE "$regex" -- ':!tools/check_secrets.sh' 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo "SECRETS: $label"
    echo "$hits" | cut -d: -f1,2 | sed 's/^/  /'
    fail=1
  fi
}

scan "32-hex token (device authKey shape)" '\b[0-9a-f]{32}\b'
scan "device serial (TNYM...)"              'TNYM[0-9A-Za-z]{8,}'
scan "JWT-like token (eyJ...)"              '\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
scan "private key block"                    'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'
scan "credentials in URL"                  '://[^ /]+:[^ /]+@'
scan "Discord bot token shape"             '\b[MN][A-Za-z0-9_]{23,25}\.eyJ'

if (( fail )); then
  echo "check_secrets: FAIL — remove the values above from tracked files"
  exit 1
fi
echo "check_secrets: clean"
