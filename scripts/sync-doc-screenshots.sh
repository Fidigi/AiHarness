#!/usr/bin/env bash
# Copy reviewed Playwright visual baselines into the human documentation.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_DIR="$ROOT_DIR/e2e/visual.spec.ts-snapshots"
TARGET_DIR="$ROOT_DIR/docs/screenshots"

MAPPINGS=(
  "trust-pwa-desktop-light-chromium-linux.png|01-workspace/trust-dialog-light.png"
  "session-info-desktop-light-chromium-linux.png|02-chat/context-usage-light.png"
  "agent-controls-desktop-light-chromium-linux.png|02-chat/agent-controls-light.png"
  "session-lifecycle-desktop-light-chromium-linux.png|03-sessions/session-lifecycle-light.png"
  "session-lifecycle-desktop-dark-chromium-linux.png|03-sessions/session-lifecycle-dark.png"
  "workspace-files-desktop-light-chromium-linux.png|04-files-git/workspace-files-light.png"
  "model-catalog-desktop-light-chromium-linux.png|05-settings/model-catalog-light.png"
  "subagent-settings-desktop-light-chromium-linux.png|05-settings/subagent-profiles-light.png"
  "extension-interaction-desktop-light-chromium-linux.png|06-extensions/interaction-confirm-light.png"
  "workspace-files-tablet-light-chromium-linux.png|07-mobile/workspace-drawer-tablet-light.png"
  "command-palette-desktop-light-chromium-linux.png|08-accessibility/command-palette-focus-light.png"
)

for mapping in "${MAPPINGS[@]}"; do
  source_name=${mapping%%|*}
  target_name=${mapping#*|}
  source_path="$SOURCE_DIR/$source_name"
  target_path="$TARGET_DIR/$target_name"
  if [[ ! -f "$source_path" ]]; then
    printf 'Missing visual baseline: %s\n' "$source_path" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$target_path")"
  cp "$source_path" "$target_path"
done

find "$TARGET_DIR" -mindepth 2 -name .gitkeep -delete
printf 'Synchronized %d documentation screenshots.\n' "${#MAPPINGS[@]}"
