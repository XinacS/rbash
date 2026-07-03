#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Cleaning previous build..."
rm -rf dist

echo "==> Installing dependencies..."
npm install

echo "==> Building TypeScript..."
npx tsup

echo "==> Making dist/index.js executable..."
chmod +x dist/index.js

echo "==> Build complete. dist/index.js is ready."
echo "    Usage: node dist/index.js --host <host> --user <user> [--key <path>]"
