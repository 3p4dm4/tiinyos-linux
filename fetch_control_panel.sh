#!/usr/bin/env bash
# fetch_control_panel.sh — install/update the community Tiiny Control Panel
# (https://github.com/0xStian/tiiny-control-panel, MIT) where the app expects it.
# Pure Python 3 stdlib, no dependencies.
set -euo pipefail
DEST="${1:-$HOME/.local/share/tiinyos-linux/control-panel}"
REPO="https://github.com/0xStian/tiiny-control-panel"
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
if [[ -d "$DEST/.git" ]]; then
  git -C "$DEST" pull --ff-only
else
  mkdir -p "$(dirname "$DEST")"
  git clone --depth 1 "$REPO" "$DEST"
fi
python3 -c "import ast,sys; ast.parse(open('$DEST/tiiny_ui.py').read()); print('control panel ready at $DEST')"
