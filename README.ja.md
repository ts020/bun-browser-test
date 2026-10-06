# bun-webview-test

[English](./README.md)

**`bun test` でブラウザのテストを書くためのモジュールです。** [`Bun.WebView`](https://bun.com/docs) で本物のブラウザ（macOS は
WKWebView、それ以外は Chrome）をふだんの `bun test` の中で動かし、[vitest のブラウザモード](https://vitest.dev/guide/browser/)と同じ形の
ロケーター、`userEvent`、`expect.element` で操作します。Playwright も別のテストランナーも要りません。vitest のブラウザモードのテストも、そのまま動かせます。

> [!NOTE]
> 非公式のモジュールで、Bun（Oven）とは関係ありません。詳しくは[このモジュールについて](#このモジュールについて)を見てください。

> [!WARNING]
> `Bun.WebView` は Bun 1.3.14 時点で experimental で、このモジュールも同じく実験的です。1.0 までは破壊的な変更が入ることがあります。

## クイックスタート

Bun **1.3.14** 以降が必要です。macOS ならそれだけで動きます。Linux では Chrome か Chromium も必要です（[必要なもの](#必要なもの)）。

1. インストールします。

   ```sh
   bun add -d bun-webview-test
   ```

2. `bunfig.toml` に preload を足します。

   ```toml
   [test]
   preload = ["bun-webview-test/preload"]
   ```

3. 表示するものと、そのテストを書きます。

   ```ts
   // src/counter.ts
   export default (root: HTMLElement, { initial }: { initial: number }) => {
     let count = initial;
     root.innerHTML = `<button>Increment</button><p role="status">count: ${count}</p>`;
     root.querySelector("button")!.addEventListener("click", () => {
       root.querySelector("[role=status]")!.textContent = `count: ${++count}`;
     });
   };
   ```

   ```ts
   // src/counter.test.ts
   import { expect, test } from "bun:test";
   import { page, userEvent } from "bun-webview-test";

   test("カウンター", async () => {
     await page.mount(new URL("./counter.ts", import.meta.url), { initial: 0 });

     await userEvent.click(page.getByRole("button", { name: "Increment" }));

     await expect.element(page.getByRole("status")).toHaveTextContent("count: 1");
   });
   ```

4. 実行します。

   ```sh
   bun test
   ```

続きは、[ページに何かを表示する](#ページに何かを表示する)、[ロケーター](#ロケーター)、[expect.element](#expectelement)、
[設定](#設定)、[CI で動かす](#ci-で動かす)、[vitest のブラウザモードのテストをそのまま動かす](#vitest-のブラウザモードのテストをそのまま動かす)を見てください。

## 必要なもの

- Bun **1.3.14** 以降（`Bun.WebView` を使います）
- ブラウザ
  - **macOS**: 既定でシステムの WKWebView を使います。追加のインストールは不要です。
  - **Linux など**: Chrome か Chromium。インストール済みの Chrome は Bun が自動で見つけます。見つからないときは `BUN_CHROME_PATH`
    に実行ファイルのパスを入れるか、`PLAYWRIGHT_BROWSERS_PATH` を Playwright のインストール先に向けるとその Chromium を使います。

macOS では、起動が軽く追加インストールも不要な WKWebView を既定としています。既存テストを複製してファイル数を増やしたローカル検証でも、Chrome より総実行時間が短くなりました。
ただし OS の WebKit バージョンに依存し、Tab・hover・touch の制約や History・CSS の挙動差があります。必要な機能や Chromium の挙動を検証したい場合は `BWT_BACKEND=chrome` に切り替えてください（[backend ごとの互換性](#backend-ごとの互換性)）。

## 設定

preload は `expect.element` を足し、テストごとにページを戻し、ページ内の未捕捉例外でテストを落とし、最後にブラウザを閉じます。

設定を変えたいときは、`bun-webview-test/preload` の代わりに自分の preload を登録します。

```ts
// test/setup.ts  （bunfig.toml の preload に "./test/setup.ts" を書く）
import { configure } from "bun-webview-test";
import "bun-webview-test/preload";

configure({ width: 375, height: 812, expectTimeout: 2000, publicDir: "./public" });
```

ブラウザは最初に `page` を触ったときに 1 回だけ起動し、全テストファイルで使い回します（Chrome の起動は 1 秒ほど、以後のページリセットは数十 ms）。ブラウザを使わないテストには何のコストもかかりません。

たくさんのテストファイルを動かすときは `bun test --parallel --no-isolate` がいちばん速くなります。vitest のブラウザモードと同じく、ブラウザで動くテストはファイルごとに新しいページで動くので、Bun 側の global を作り直さなくてもテスト同士は分離されています（`--isolate` で増えるのは、Bun 側の `mock` などの状態の分離です）。

`bun test --parallel`（と `--isolate`）でも使えます。Chrome はワーカーのプロセスごとに 1 回だけ起動し、ファイルごとに global が作り直されても使い回します（プロセスが終わると止まります）。この使い回しをやめたいときは `BWT_SHARED_CHROME=0` にします。

### 設定の一覧

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| `backend` | macOS は `"webkit"`、他は `"chrome"` | 環境変数 `BWT_BACKEND` でも指定可 |
| `chromePath` | `BUN_CHROME_PATH` か Playwright の Chromium | Chrome の場所。未指定なら Bun が自動検出 |
| `chromeArgs` | root 実行時は `["--no-sandbox"]` | Chrome への追加引数 |
| `width` / `height` | 1280 / 720 | ビューポート |
| `actionTimeout` | 3000 | click などが要素を待つ時間 (ms) |
| `expectTimeout` | 1000 | `expect.element` がリトライする時間 (ms) |
| `failOnPageError` | `true` | ページ内の未捕捉例外でテストを落とす |
| `resetBetweenTests` | `true` | テストごとに空のページへ戻す |
| `forwardConsole` | `true` | ページの `console.*` を Bun のコンソールに流す |
| `publicDir` | なし | `page.goto("/x.html")` で配信するディレクトリ |

## ページに何かを表示する

- `page.setContent(html)` は HTML 文字列を表示します。HTML を返すレンダラーなら、Bun 側で文字列を作ってそのまま渡せます。
- `page.mount(entry, props)` は `entry` を `Bun.build` でブラウザ向けにバンドルし、`export default (root, props) => void | cleanup` を呼びます。`import "./x.css"` した CSS も読み込まれます。React などを使う場合は、この関数の中で `createRoot(root).render(...)` してください。
- `page.importModule<typeof import("./x")>(entry)` はモジュールを読み込み、`mod.call("fn", ...args)` で関数をページ内で呼べます。引数と戻り値には型が付きます（中身は JSON でやり取りします）。
- `page.evaluate((a) => ..., a)` は関数を文字列にしてページで実行します。外側の変数は参照できないので、値は引数で渡します。
- `page.goto(url)`、`page.screenshot({ path })`、`page.setViewport(w, h)`、`page.view()`（生の `Bun.WebView`）もあります。

## ロケーター

`page.getByRole` / `getByText` / `getByLabelText` / `getByPlaceholder` / `getByAltText` / `getByTitle` / `getByTestId` / `locator(css)` と、`nth` / `first` / `last` / `filter({ hasText, has })` が使えます。どれもチェーンできます。

ロケーターは「探し方」だけを持っていて、操作やアサーションのたびにページ内で解決し直します。操作するときに要素が 2 つ以上見つかるとエラーになります（Playwright と同じ strict mode）。0 個のときは現れるまで待ちます。

`click` / `dblclick` / `fill` / `clear` / `type` / `press` / `check` / `uncheck` / `selectOptions` / `focus` / `scrollIntoView` / `hover`（Chrome のみ）があり、クリックとキー入力は `Bun.WebView` のネイティブ入力なので、ページ側のイベントは `isTrusted: true` になります。

`userEvent` は vitest に寄せた薄いラッパーです。`userEvent.keyboard("abc{Enter}{Shift+Tab}")` のようにキーを書けます。

## expect.element

preload が `expect.element` を足します（型も `bun:test` に追加されます）。条件を満たすまでリトライするので、描画待ちのコードはいりません。必ず `await` してください。

`toBeInTheDocument` `toBeVisible` `toBeHidden` `toHaveTextContent` `toHaveValue` `toHaveAttribute` `toHaveClass` `toHaveStyle`（`getComputedStyle` と比較） `toBeChecked` `toBePartiallyChecked` `toBeDisabled` `toBeEnabled` `toBeFocused` `toHaveAccessibleName` `toHaveRole` `toHaveCount`、と `.not` が使えます。

## vitest のブラウザモードとの違い

vitest はテストファイルそのものをブラウザで動かします。こちらはテストは Bun で動き、ブラウザをリモート操作します（Playwright の component testing に近い形です）。

- よい点: `bun test` の `mock` / スナップショット / ファイルシステムなどがそのまま使えます。テスト対象のコードだけがバンドルされてブラウザに送られます。
- 注意点: テストコードから DOM 要素を直接触ることはできません。ページ内で何かするときは `page.evaluate` か `importModule().call()` を使います。

## vitest のブラウザモードのテストをそのまま動かす

`bun-webview-test/vitest-preload` を preload に足すと、`vitest/browser` を import しているテストファイル（または `*.browser.test.ts`）は Bun では実行されず、ページの中で vitest 自身のランナー（`@vitest/runner`、`expect`、`@vitest/browser` の `page` / `userEvent` / ロケーター / `expect.element`）で動きます。結果は `bun test` のテストとして報告されます。

```toml
# bunfig.toml
[test]
preload = ["bun-webview-test/preload", "bun-webview-test/vitest-preload"]
```

`vitest/browser` の型を使うには、`compilerOptions.types` に `bun-webview-test/vitest-types` を足します。

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "types": ["bun", "bun-webview-test/vitest-types"]
  }
}
```

設定は vitest.config の代わりに、テストファイルからいちばん近い `bwt.config.ts` に書きます（そのディレクトリが `root` になり、既定でその下のテストはすべてブラウザで動きます）。

```ts
// bwt.config.ts
import { defineConfig } from "bun-webview-test/vitest";

export default defineConfig({
  setupFiles: ["./setup.ts"],
  viewport: { width: 414, height: 896 },
  actionTimeout: 500, // providers.playwright({ actionTimeout })
  locators: { errorFormat: "aria" },
  alias: { "#src": "./src" },
  optimizeDeps: { include: ["some-cjs-lib"] },
  commands: { myCommand: (ctx, arg) => arg },
  screenshotFailures: false,
});
```

環境変数 `BWT_CONFIG` に JSON を入れると、CLI オプションのように設定を上書きできます（例: `BWT_CONFIG='{"locators":{"errorFormat":"html"}}' bun test`）。

### backend ごとの互換性

結果を比較するときは `BWT_BACKEND=chrome` / `BWT_BACKEND=webkit` を明示してください。WKWebView は macOS のシステム WebKit を使い、Playwright WebKit とはビルドが異なります。以下は Bun 1.4.2 / macOS 26.6.2 / Chromium 145.0.7632.6 で確認した内容です。エンジンの更新で挙動は変わることがあります。

| 機能・挙動 | Chrome | WKWebView |
| --- | --- | --- |
| `focus()` / `:focus` / `document.hasFocus()` | 対応。focus emulation を有効化 | 対応。setup・テストの読み込み前に **iframe 要素**をフォーカス。Shadow DOM も対象 |
| `userEvent.tab()` | ネイティブのフォーカス移動 | Bun 1.4.2 の修飾キーなし Tab では移動も `keydown` も発生しない。キーボードナビゲーションのテストは Chrome を使用 |
| `new TouchEvent(...)` | コンストラクターあり | 検証した macOS ビルドでは未提供 |
| `userEvent.hover()` / `unhover()` | 対応 | 未対応。Chrome backend が必要という明示的なエラー |
| `history.pushState()` / `replaceState()` | 101回の更新ではエラーなし | 合計100回 / 10秒の制限。101回目の `replaceState()` で `SecurityError` |
| CSS URL のシリアライズ・寸法 | ブラウザの表記・丸めに従う | 引用符なし URL のエスケープや小数の丸めに差が出る |

**focus と Tab は別の問題です。** iframe の `contentWindow.focus()` だけでは、`activeElement` が更新されても `:focus` が有効にならないことがあります。ランナーはテスト開始前に iframe 要素をフォーカスします。一方、Tab はフォーカス済みでも input 同士の移動ができません。プラグインを使わない `Bun.WebView` でも再現し、Bun は修飾キーなしの Tab をネイティブキーイベントではなく `InsertTab` 編集コマンドへ送っています（[Bun 1.4.2 の実装](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/webview/WebViewHost.cpp#L494-L579)）。この経路について macOS のキーボードナビゲーション設定の変更は確認済みの回避策ではありません。WebKit がどの要素を Tab 対象にするかは別の問題で、リンクを飛ばすだけでは入力経路の問題と断定できません。

**Touch:** コンストラクターやイベントハンドラーのテストは Chrome で実行し、WKWebView でも実行する場合は API の有無を確認してください。Polyfill や `dispatchEvent(new TouchEvent(...))` は合成イベントであり、実際のタッチ入力を検証できません。このパッケージにはネイティブの tap／タッチエミュレーション用の高水準 API はありません。

**History:** setup・テスト本体・cleanup の更新が同じ回数制限を消費します。冗長な更新を減らし、大きなルーターテストは `.browser.test.ts` を分割してください。Vitest 互換モードではファイルごとに新しい WebView を作ります。`document.body.innerHTML = ''` では History はリセットされず、直接検証した WKWebView では `view.reload()` 後も制限が残りました。新しい WebView ではリセットされます。実行中の Vitest tester iframe を reload するとテストランタイムも再起動するため、状態リセットには使わないでください。WebKit の制限そのものが検証対象でなければ Chrome での実行も選べます。

**CSS:** WebKit では `url(regular.jpg)` が `url(regular\.jpg)` として返ることがあります。カスタムプロパティに URL を設定するときは引用符付きにするか、シリアライズされた CSS にファイル名が含まれるかではなく描画結果を検証してください。寸法はピクセル文字列の完全一致ではなく、コンポーネントに適した誤差を許容して数値を比較します。

```ts
el.style.setProperty('--image', 'url("regular.jpg")');
expect(el.getBoundingClientRect().width).toBeCloseTo(100, 3);
```

Vitest の結果はブラウザ内のテストファイルが完了してから Bun に登録します。実行中の skip とフックの失敗を確定してから報告し、実行対象がない suite 内でも todo は todo として扱います。

### vitest と同じに動くもの

vitest v5.0.3 の `test/browser`（テスト・fixtures・specs）をこのパッケージに移植してあり、Chrome backend ですべて通ります。

- vitest と同じく、テストはオーケストレーターのページに置いた iframe（ビューポートの大きさ）の中で動きます。`window.top` や `window.frameElement` を前提にしたテストもそのまま動きます。
- Vite と同じようなモジュールごとの配信（ソースマップ付き）、`node_modules` の事前バンドル（CommonJS の named export も含む）、`import.meta.env` と `.env`、CSS / CSS Modules / JSON / `?raw` / `?url` / アセット、エイリアス、`server.headers`、テスターの HTML（`testerHtmlPath`）
- ロケーターと `userEvent`（ネイティブ入力なので `isTrusted: true`）、`expect.element`、`toMatchScreenshot`、`page.screenshot`、`page.viewport`、`cdp()`、カスタムコマンド、`readFile` などの fs コマンド（Vite の `server.fs.allow` と同じアクセス制限）
- スナップショット（ファイル・インライン・`toMatchFileSnapshot`・ARIA スナップショット）
- 動作のタイムアウト（明示指定 → `actionTimeout` → テストやフックの残り時間）、テストのタイムアウトが待っている動作の名前を出すこと
- エラーのスタックを元のファイル（依存パッケージの元のソースを含む）の行と列に戻すこと、失敗時のスクリーンショット、未捕捉エラーの「どのテストの最中に起きたか」の説明、`trackUnhandledErrors` / `onUnhandledError`

### 対応していないもの

- **`vi.mock` / `vi.doMock` / `vi.hoisted` などのモジュールのモックは、意図して対象外にしています。** 差し替えたい関数をオブジェクトのメソッドとして export し、ブラウザのテストでは `vi.spyOn`、Bun 側のテストでは `bun:test` の `mock` / `spyOn` で置き換えてください。

  ```ts
  // calculator.ts
  export const calculator = { add: (a: number, b: number) => a + b };

  // calculator.browser.test.ts
  import { expect, test, vi } from "vitest";
  import { calculator } from "./calculator";

  test("spy", () => {
    vi.spyOn(calculator, "add").mockReturnValue(42);
    expect(calculator.add(1, 2)).toBe(42);
  });
  ```

- トレース（`trace`）は未対応です。
- `beforeAll` の失敗は、そのスイートの最初のテストの失敗として、`afterAll` の失敗はスイートの `afterAll` として `bun test` に表示されます（vitest はスイートの失敗として表示します）。
- 未捕捉エラーはファイルの最後に `(unnamed)` の失敗として表示されます。

## CI で動かす

GitHub Actions の Ubuntu 24.04 ランナーでは、AppArmor が非特権のユーザー名前空間を制限しているため、そのままでは Chrome のサンドボックスが起動できません。

```yaml
- uses: oven-sh/setup-bun@v2
- run: bun install --frozen-lockfile
- run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
- run: BUN_CHROME_PATH="$(command -v google-chrome)" bun test
```

root で動かすとき（Docker など）は `--no-sandbox` が自動で付きます。

ブラウザは最初に `page` を触ったテストの中で起動するので、起動の時間はそのテストのタイムアウトに含まれます。CI の初回は Chrome の起動に数秒かかることがあるので、長めのタイムアウトを付けた `beforeAll` で先に起動しておくと安心です。

```ts
import { beforeAll } from "bun:test";
import { getSession } from "bun-webview-test";

beforeAll(() => getSession(), 30_000);
```

## 速度

vitest 5.0.3 のブラウザモード（`@vitest/browser-playwright`）と、同じマシン（4 コア）・同じヘッドレス Chromium で、移植した `test/browser/test`（21 ファイル、127 テスト）を動かして比べました。時間はプロセスの起動から終了まで、warm で 5 回の中央値です。計測スクリプトは [`bench/vitest-browser`](bench/vitest-browser) にあります。

| | 時間 |
| --- | --- |
| bun-webview-test、`bun test --parallel --no-isolate`（推奨） | **5.0s** |
| bun-webview-test、`bun test --parallel` | 5.5s |
| bun-webview-test、`bun test`（1 ファイルずつ） | 7.5s |
| vitest（既定、ファイル並列） | 6.3s |
| vitest（`--no-file-parallelism`） | 7.6s |

起動（テスト 1 件だけのファイル。cold はキャッシュ `.vite` / `.bwt` を消してからの値）

| | 時間 cold / warm | 最大メモリ |
| --- | --- | --- |
| bun-webview-test | 0.53s / 0.53s | 329MB |
| vitest | 2.42s / 2.00s | 788MB / 567MB |

`--parallel --no-isolate` なら、テスト全体は vitest の既定の並列実行より約 2 割速く、起動は約 4 倍速くなります。1 ファイルずつ動かしたときの最大メモリ（Chromium を含むプロセス全体の PSS）は、vitest のおよそ半分です（382MB と 770MB）。

## このモジュールについて

非公式のモジュールです。Bun（Oven）とは関係ありません。

bun-webview-test は、`bun test` にまだブラウザモードがないので作ったものです。Bun 本体がブラウザでのテストをサポートし、
このモジュールが役目を終える日が来ることを望んでいます。Bun に同等の機能が入ったら、そちらを使ってください。
Bun へのブラウザモードの要望は、作者ではなく [Bun の issue](https://github.com/oven-sh/bun/issues) に送ってください。
作者は Bun のチームの人間ではないので、Bun 本体への要望には対応できません。

## 開発

```sh
bun install
bun test            # Linux では Chrome が必要（BUN_CHROME_PATH、なければ PLAYWRIGHT_BROWSERS_PATH の Chromium を使う）
bun run typecheck
bun run build       # 型定義を dist/ に出力
bun run lint:package
```

利用者に影響する変更には changeset を付けてください（`bun run changeset`）。公開の流れは [RELEASING.md](./RELEASING.md) にあります。

## ライセンス

[MIT](./LICENSE)。一部は vitest（MIT）と Playwright（Apache-2.0）から移植しています。[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を見てください。
