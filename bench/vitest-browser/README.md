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
既定は20組、100ファイル・800テスト（スクリーンショット100回）、2ワーカーです。800種類のテストではありません。
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
- Summary に実行時間の中央値・各回のピークPSSの中央値（MiB）と、Vitestに対する時間・メモリの削減率を表示します。負の削減率は bun-webview-test のコストが高いことを表します。
- `benchmark-results-*` artifact に結果・メタデータ・比較用依存の `package-lock.json`・ログを30日保存します。

ホスト型ランナーでは実行ごとに負荷や CPU 性能が変わるため、速度の閾値は設けていません。
macOS の4ワーカーの掲載値と CI の2ワーカーの値は直接比較できません。
時間計測の後に、同じ条件で両ランナーのメモリを別途計測します。以前の時間のみの結果や `bench.py` の直列スイートとは分けて扱います。

同じ設定をLinuxで動かす例（先に `bun src/cli.ts install` を実行）：

```sh
python3 bench/vitest-browser/scaling.py --chrome-shell /absolute/path/to/chrome-headless-shell --groups 20 --workers 2 --runs 3 --memory
```

### 比較条件とメモリ計測

| 条件 | bun-webview-test | Vitest Browser Mode |
| --- | --- | --- |
| 並列実行 | `--parallel=2 --no-isolate` | `maxWorkers: 2`, `fileParallelism: true` |
| ブラウザ内の分離 | ファイルごとに新しいdocument | `browser.isolate: true`、ファイルごとに新しいiframe |
| ブラウザ・テスト・画面サイズ | 同じHeadless Shell実行ファイル・同じ生成ファイル・414×896 | 同左 |
| ウォームアップ・反復 | 時間・メモリそれぞれ1回＋計測3回 | 同左 |

Bunの `--no-isolate` はホスト側の状態を維持する設定です。本パッケージではブラウザのDOM・グローバル・モジュールはファイルごとに作り直します。
Vitestの `browser.isolate: false` はブラウザ内の状態も共有するため、比較には使いません。
起動引数、ブラウザプロセス数、storage/contextの寿命は各実装に従い、そのコストも計測対象です。

`--memory` はLinux専用です。`/proc/<pid>/smaps_rollup` のPSSを目標50ms間隔で集計します。
ランナー・ワーカー・サーバー・ブラウザを含め、共有メモリは利用割合に応じて数えます。
専用セッションと実行ごとの環境マーカーで、親から切り離されたChromeも追跡します。無関係なプロセスとPythonの計測処理は含みません。
各時点の合計の最大値をその回のピークとし、ウォームアップを除いた3回のピークの中央値を比較します。
個々のプロセスの最大値を足した値ではなく、短いピークはサンプリングで見逃す可能性があります。

時間計測中にはメモリをサンプリングしません。メモリ計測用の実行は `phase: "memory"` として保存し、その実行時間は速度の中央値に混ぜません。
どちらのフェーズでも成功テスト数とファイル数を確認し、終了後に子プロセスが残れば停止して計測を失敗にします。
PSSが読めない場合も0として処理せず失敗にします。Linux以外では `--memory` を省略すると時間のみを測れます。

`metadata.json` には実行コマンド・分離設定・ワーカー数・計測方法を保存します。
`results.json` のメモリ行には `peak_pss_mib`・`memory_samples`・`peak_process_count` を、
`summary.json` には `median_peak_pss_mib` と削減率を記録します。

### Recorded Linux CI result

[PR #7の実行](https://github.com/ts020/bun-browser-test/actions/runs/37551576464)で、上記の時間・メモリ計測を検証しました。
Ubuntu 24.04 x64、Bun 1.4.2、Node 24.21.0、Vitest 5.0.3、Playwright 1.56.1、同じChrome Headless Shell 145.0.7632.6、双方2ワーカーです。
100ファイル・800テスト・スクリーンショット100回について、各フェーズでウォームアップ1回＋計測3回を実行しています。

| ランナー | 時間の中央値 | ピークPSSの中央値 |
| --- | ---: | ---: |
| bun-webview-test | 9.49秒 | 674.3 MiB |
| Vitest Browser Mode | 11.10秒 | 885.5 MiB |

この実行では時間が14.5%短縮、ピークPSSが23.9%少ない結果でした。
[保存した生の計測値・メタデータ](scaling-results-linux-ci-memory.json)には、全16回の結果とPRのテスト用merge commitを記録しています。

以前の[PR #6の時間のみの計測](https://github.com/ts020/bun-browser-test/actions/runs/37550092193)は、10.31秒対12.99秒（20.7%短縮）でした。
その[生データ](scaling-results-linux-ci.json)も保持しています。ホスト型ランナーでは負荷が変わるため、実行間の差をそのまま性能改善・悪化とはみなせません。
GitHubのartifact保存期間が過ぎても、これらのJSONで掲載値を確認できます。

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

## Earlier Linux measurements

以前の計測では、同じ4コアのLinuxマシン・同じ通常版Chromiumの実行ファイルを使い、
移植した `test/browser/test`（21ファイル・127テスト）をVitest 5.0.3 Browser Mode（`@vitest/browser-playwright`）と比較しました。
プロセスの起動から終了までの実時間を測った、warm実行5回の中央値です。計測スクリプトは [`bench.py`](bench.py) です。

| 実行方法 | 時間 |
| --- | --- |
| bun-webview-test, `bun test --parallel --no-isolate` | **5.0s** |
| bun-webview-test, `bun test --parallel` | 5.5s |
| bun-webview-test, `bun test`（直列） | 7.5s |
| Vitest（既定、ファイルを並列実行） | 6.3s |
| Vitest (`--no-file-parallelism`) | 7.6s |

### Earlier memory measurements

以下も以前のLinux計測で、同じ通常版Chromiumを使った結果です。
最大メモリはChromiumを含むプロセスツリーのPSSを50msごとに合計した最大値で、共有ページは利用割合に応じて数えています。
単位はMiBです（スクリプトの表記はMB）。起動時の比較は単一テストを使い、cold実行の前には `.vite` / `.bwt` キャッシュを削除しています。

| ランナー | 時間（cold / warm） | 最大メモリ |
| --- | --- | --- |
| bun-webview-test | 0.53s / 0.53s | 329 MiB |
| Vitest | 2.42s / 2.00s | 788 / 567 MiB (cold / warm) |

| 直列スイート、21ファイル・127テスト | 最大メモリ（PSS） |
| --- | ---: |
| bun-webview-test | 382 MiB |
| Vitest | 770 MiB |

このワークロードでは、`--parallel --no-isolate` のスイート実行時間はVitest既定比で約20%短縮しました。
単一テストの起動から終了までの時間は約75%以上短縮し、直列スイートの最大メモリは約50%少ない結果でした。
現在のHeadless Shell構成・macOSのスケーリング比較・WKWebViewのメモリは未計測です。ワーカー数やテスト内容によって使用量は変わります。
