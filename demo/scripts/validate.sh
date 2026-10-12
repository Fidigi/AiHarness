#!/usr/bin/env bash
set -euo pipefail
cd /app
# Record the exact shared renderer/focus/font inputs baked into this validation image.
sha256sum packages/web/src/components/MarkdownContent* packages/web/src/components/markdown-*.ts \
  packages/web/src/hooks/useFocusTrap.ts .docker/test-fonts.conf
node --test demo/tests/*.test.mjs
node --test .docker/test-fonts.test.mjs
./node_modules/.bin/tsc --noEmit -p demo/tsconfig.json
node demo/scripts/build.mjs
node demo/scripts/playwright.mjs "$@"
