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

## File-count scaling

`scaling.py` は `basic`・`dom`・`env`・`findElement`・`utils` の既存テストを内容を変えずに複製します。
既定は20組、100ファイル・800テスト（スクリーンショット100回）。800種類のテストではありません。
1つのプロジェクト設定を共有し、両ランナーが同じファイルと Chromium バイナリを実行します。

```sh
python3 bench/vitest-browser/scaling.py --chrome /absolute/path/to/chrome --chrome-shell /absolute/path/to/chrome-headless-shell --groups 20 --workers 4 --runs 3 --webkit
```

リポジトリの依存を `bun install` で入れ、Bun・Node.js・npm・Python 3 を用意してください。
`--webkit` は macOS のみです。他の OS では省略してください。
`--chrome-shell` を追加すると Headless Shell でも両ランナーを比較します。
Shell だけを比較する場合は `--chrome` を省略して `--chrome-shell` だけを指定できます（`BUN_CHROME_PATH` も未設定にします）。
スクリプトが `.scaling/` にテストと比較用の固定バージョンの依存を用意するため、従来の `setup.sh` は不要です。
各ランナーで1回ウォームアップしてから指定回数を計測し、実行順を交代させます。計測は同時に走らせません。
起動・後始末・終了を含む実時間を測り、毎回の終了コードと成功テスト数・ファイル数を確認します。
`.scaling/results.json`・`metadata.json`・各実行のログに結果を保存し、成功時は `summary.json`・`summary.md` も出力します。

Apple M2 Pro / macOS 26.6.2、Bun 1.4.2、Node 26.3.0、Chromium 145.0.7632.6、
Vitest 5.0.3 / Playwright 1.56.1、4ワーカー、3回の中央値：

| 実行ブラウザ | bun-webview-test | Vitest / Playwright |
| --- | ---: | ---: |
| Chrome Headless Shell | 3.93 | 5.35 |
| 通常版 Chrome、ヘッドレス | 8.14 | 9.21 |
| WKWebView | 8.14 | — |

bun-webview-test は `--parallel=4 --no-isolate`、Vitest は `maxWorkers: 4`。
各ペアは同じ実行ファイルを使用しています。通常版・Shell とも Chromium 145.0.7632.6 です。
実行時間は Vitest 比で通常版11.6%、Shell26.5%短縮。変更前の通常版 Chrome は14.90秒でした。
[生の計測値とテストのハッシュ](scaling-results-macos.json)も保存しています。
この値はファイル数が多い場合の1環境での結果であり、すべてのスイートや OS での優位性を示すものではありません。
この計測ではメモリを測っていません。

通常版 Chrome のプロファイルでは、ページ切り替え時に macOS のカメラ・マイク権限確認
（`AVCaptureDevice.authorizationStatusForMediaType` → TCC の同期 IPC）が待ち時間を占めていました。
空のページでも再現したため、テストコードだけに由来する差ではありません。
仮想メディアデバイスの実験も行いましたが、公開の比較値と実装では有効にしていません。

[Headless Shell は通常版 Chrome と別の実装](https://developer.chrome.com/docs/automation-and-testing/headless#use-old-headless-mode)です。
機能・描画が完全に同じという比較ではありません。両ランナーに同じ種類・バージョンを指定し、
CI と開発環境でも固定してください。

## CI benchmark

[Browser benchmark](../../.github/workflows/benchmark.yml) は、関連ファイルの PR・`main` への push と `workflow_dispatch` に対応します。
GitHub Actions の **Browser benchmark → Run workflow** から手動実行できます。新しいワークフローは default branch に取り込まれてから手動実行できます。

- Ubuntu 24.04、Bun 1.4.2、Node 24、Python 3.12。Node の patch 版など実際の実行環境は `metadata.json` に記録します。
- 本パッケージの CLI で取得した同じ Headless Shell を両ランナーに明示指定します。ブラウザ導入や npm install は計測区間に含めません。
- 100ファイル・800テスト・スクリーンショット100回、2ワーカー、ウォームアップ1回＋計測3回。ランナーを順番に動かし、順序は回ごとに交代します。
- 各回の終了コードだけでなく成功テスト数・ファイル数も確認します。失敗時はジョブも失敗し、残っているログを保存します。
- Summary に中央値と Vitest に対する実行時間の短縮率を表示します。負の短縮率は bun-webview-test のほうが遅いことを表します。
- `benchmark-results-*` artifact に結果・メタデータ・比較用依存の `package-lock.json`・ログを30日保存します。

ホスト型ランナーでは実行ごとに負荷や CPU 性能が変わるため、速度の閾値は設けていません。
macOS の4ワーカーの掲載値と CI の2ワーカーの値は直接比較できません。
この CI は時間のみを測定します。メモリは従来の Linux 用 `bench.py` の計測であり、今回の Shell 構成の値とは分けて扱います。

同じ設定をローカルで動かす例（先に `bun src/cli.ts install` を実行）：

```sh
python3 bench/vitest-browser/scaling.py --chrome-shell /absolute/path/to/chrome-headless-shell --groups 20 --workers 2 --runs 3
```

## Installation size

[npm ファイル容量の計測値](installation-size-results-macos.json)は、macOS arm64 / Bun 1.4.2 で独立した空のプロジェクトへ `bun install --ignore-scripts` したスナップショットです。
本パッケージ側は `bun run build` 後に `bun pm pack --ignore-scripts` で作ったローカル tarball のみを依存に追加し、
比較側は `vitest@5.0.3`・`@vitest/browser-playwright@5.0.3`・`playwright@1.56.1` を追加しました。
本パッケージ自身の開発用依存は含みません。実際に解決されたパッケージ名・バージョン、tarball の SHA-256 も JSON に保存しています。
README の比較説明を追加する前の作業版の計測です。

各プロジェクト内で次のように数えます。シンボリックリンク先を重複して数えず、通常ファイルの論理サイズを合計します。

```sh
python3 - <<'PY'
import os
from pathlib import Path
files = [Path(base) / name for base, _, names in os.walk('node_modules')
         for name in names if not (Path(base) / name).is_symlink()]
size = sum(path.stat().st_size for path in files)
print(f'{size} bytes ({size / 1_000_000:.1f} MB)')
PY
```

ブラウザ・Bun/Node 本体・グローバルキャッシュ・ファイルシステムの割当単位による増分は対象外です。
既存プロジェクトでは依存の共有や解決バージョンが変わるため、追加で必要な容量はこの数字と一致しません。
通信量や導入時間を測定した値でもありません。

[ブラウザ ZIP 容量](browser-download-sizes.json)は、記載された公式 URL へ HTTPS HEAD で問い合わせた `Content-Length` です。
同じ種類・バージョン・プラットフォームのバイナリを選べば、どちらのランナーでもブラウザ本体の容量は同じです。
