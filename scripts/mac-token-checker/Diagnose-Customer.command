#!/bin/bash
set -u
CHECKER_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$CHECKER_DIR/Start-Check.command" --diagnose-customer
