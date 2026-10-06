# bun-webview-test と vitest browser mode の性能比較

同じテスト（ルートの `test/browser/test`、vitest v5.0.3 の `test/browser/test` の移植。21 ファイル / 127 テスト）を、
bun-webview-test（`bun test`）、vitest 5.0.3 + `@vitest/browser-playwright`（Playwright の Chromium、ヘッドレス）、
vitest 5.0.3 + [vitest-browser-bun](https://www.npmjs.com/package/vitest-browser-bun) 0.0.4（vitest を Bun で動かし、provider に Bun.WebView を使う）で動かして比べる。
どれも同じ Chromium バイナリ（`$PLAYWRIGHT_BROWSERS_PATH/chromium-1194`）を使う。vitest の provider は環境変数 `BENCH_PROVIDER`（`provider.mts`）で切り替える。

```sh
./setup.sh          # テストを test/browser にコピーして vitest を入れる
python3 bench.py 5  # cold / warm を 5 回ずつ
python3 bench.py 5 suite/bwt-par   # 一部だけ（名前の前方一致）
```

- `suite`: 上のテスト全体
  - `bwt`: `bun test`（1 ファイルずつ）。`bwt-par` / `bwt-par2` は `--parallel`（コア数 / 2 ワーカー）、`bwt-par-noiso` は `--parallel --no-isolate`
  - `vitest`: Playwright、既定。`vitest-w4` は `--maxWorkers=<コア数>`、`vitest-seq` は `--no-file-parallelism`
  - `vbb`: vitest-browser-bun の既定（ファイルは 1 つずつ）。`vbb-par` は `bun-webview-parallel` 0.0.3 のファクトリ（`pool: true`）と `--maxWorkers=<コア数>`
- `startup`: 1 テストだけのファイル（`startup/trivial.test.ts`）。起動と終了のコスト
- 時間はプロセスの起動から終了までの wall time、メモリは子孫プロセスと Chromium の PSS 合計の最大値（`bench.py` の説明を参照）。CPU はマシン全体の user + system 時間
- vitest 側の `vitest.config.mts` は元の設定から Chromium 以外のブラウザ、typecheck、benchmark、trace を外したもの
