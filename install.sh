#!/bin/bash
# Install or update the KB S3 Sync plugin in your Obsidian vault.
#
# Usage:
#   ./install.sh /path/to/your/vault
#
# Example:
#   ./install.sh ~/Documents/MyVault

set -e

if [ -z "$1" ]; then
  echo "Usage: ./install.sh /path/to/your/vault"
  exit 1
fi

VAULT="$1"
PLUGIN_DIR="$VAULT/.obsidian/plugins/kb-s3-sync"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist/kb-s3-sync"

if [ ! -d "$DIST_DIR" ]; then
  echo "Error: dist/kb-s3-sync not found. Run 'npm run build' first, then copy files to dist/."
  exit 1
fi

mkdir -p "$PLUGIN_DIR"
cp "$DIST_DIR/main.js" "$DIST_DIR/manifest.json" "$DIST_DIR/styles.css" "$PLUGIN_DIR/"

echo "Installed to $PLUGIN_DIR"
echo "Restart Obsidian or run 'Reload app without saving' (Cmd+Shift+R) to pick up changes."
