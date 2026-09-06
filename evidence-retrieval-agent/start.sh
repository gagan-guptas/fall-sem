#!/usr/bin/env bash
# Start the Evidence Agent backend (zero npm deps — pure Node.js)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

echo "🚀 Starting Agent 6 backend on http://localhost:8001"
echo "   Open frontend/index.html in your browser."
echo ""

node "$BACKEND_DIR/server.js"
