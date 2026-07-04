#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building TypeScript..."
npx tsup

echo "==> Building tests..."
npx tsc -p tsconfig.test.json

echo "==> Running tests..."
node --test tests/dist/*.test.js
