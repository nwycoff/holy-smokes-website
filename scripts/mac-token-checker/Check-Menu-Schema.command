#!/bin/bash
set -u
CHECKER_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  printf '%s\n' 'Node.js is not installed or was not found.' 'Install the macOS LTS installer from https://nodejs.org/en/download' 'Then close and reopen Terminal and run this checker again.'
  exit 1
fi
if ! env -u NODE_OPTIONS -u NODE_DEBUG "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  printf '%s\n' 'This checker needs Node.js 22 or newer. Install the current LTS macOS installer from https://nodejs.org/en/download'
  exit 1
fi
env -u NODE_OPTIONS -u NODE_DEBUG "$NODE_BIN" "$CHECKER_DIR/menu-schema.mjs"
CHECK_EXIT=$?
printf '\n%s\n' 'You can copy the OK/DIFF/NOTE/RESULT lines above. Do not share your token or menu key.'
if [ -t 0 ]; then read -r -p 'Press Enter to close this checker...' _; fi
exit "$CHECK_EXIT"
