#!/bin/sh
# Install zcode-run onto your PATH.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

# Find a writable PATH dir
BIN_DIR=""
for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/bin" /usr/local/bin; do
  if [ -d "$d" ] && [ -w "$d" ]; then BIN_DIR="$d"; break; fi
done
if [ -z "$BIN_DIR" ]; then
  mkdir -p "$HOME/.local/bin" && BIN_DIR="$HOME/.local/bin"
fi

chmod +x "$DIR/bin/zcode-run.mjs" "$DIR/bin/zcode-provider-setup.mjs"
ln -sf "$DIR/bin/zcode-run.mjs" "$BIN_DIR/zcode-run"
ln -sf "$DIR/bin/zcode-provider-setup.mjs" "$BIN_DIR/zcode-provider-setup"

echo "installed:"
echo "  $BIN_DIR/zcode-run"
echo "  $BIN_DIR/zcode-provider-setup"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""; echo "NOTE: $BIN_DIR is not on your PATH. Add it to your shell profile."; ;;
esac

echo ""
echo "next: register the headless model provider"
echo "  $BIN_DIR/zcode-provider-setup"
echo "then test:"
echo "  zcode-run 'Reply with exactly: pong' --cwd ~ --mode plan"
