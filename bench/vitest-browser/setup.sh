#!/usr/bin/env bash
# ../../test/browser（vitest v5.0.3 の test/browser の移植）を test/browser にコピー（テストがディレクトリ名に依存するため同じ名前にする）し、vitest 用に元の設定を置く
set -euo pipefail
cd "$(dirname "$0")"
SRC=../../test/browser
rm -rf test && mkdir -p test/browser
cp -r "$SRC"/{test,src,cjs-lib,bundled-lib,custom-tester.html,injected.ts,package.json,.env.local} test/browser/
cp vitest.config.mts provider.mts custom-diff-config.ts test/browser/
npm install --no-audit --no-fund
