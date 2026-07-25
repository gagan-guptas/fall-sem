#!/usr/bin/env bash
# Start the Deepfake Evidence Agent backend (zero npm deps — pure Node.js)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

echo "🎭 Starting backend on http://localhost:8002"
echo "   Open frontend/index.html in your browser."
echo ""

node "$BACKEND_DIR/server.js"
