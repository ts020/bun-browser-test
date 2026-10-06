# bun-webview-test

[English](./README.md)

`bun test` と [`Bun.WebView`](https://bun.com/docs) で、[vitest のブラウザモード](https://vitest.dev/guide/browser/)のようなテストを書くためのモジュールです。
Playwright も別プロセスのテストランナーも使わず、`bun test` の中で本物のブラウザ（macOS は WKWebView、それ以外は Chrome）を動かします。

```ts
import { expect, test } from "bun:test";
import { page, userEvent } from "bun-webview-test";

test("カウンター", async () => {
  await page.mount(new URL("./Counter.ts", import.meta.url), { initial: 0 });

  await userEvent.click(page.getByRole("button", { name: "Increment" }));

  await expect.element(page.getByRole("status")).toHaveTextContent("count: 1");
});
```

> [!NOTE]
> **非公式のモジュールです。Bun（Oven）とは関係ありません。**
> bun-webview-test は、`bun test` にまだブラウザモードがないので作ったものです。Bun 本体がブラウザでのテストをサポートし、
> このモジュールが役目を終える日が来ることを望んでいます。Bun に同等の機能が入ったら、そちらを使ってください。
> Bun へのブラウザモードの要望は、作者ではなく [Bun の issue](https://github.com/oven-sh/bun/issues) に送ってください。
> 作者は Bun のチームの人間ではないので、Bun 本体への要望には対応できません。

> [!WARNING]
> `Bun.WebView` は Bun 1.3.14 時点で experimental で、このモジュールも同じく実験的です。1.0 までは破壊的な変更が入ることがあります。

## 必要なもの

- Bun **1.3.14** 以降（`Bun.WebView` を使います）
- ブラウザ
  - **macOS**: 既定でシステムの WKWebView を使います。追加のインストールは不要です。
  - **Linux など**: Chrome か Chromium。インストール済みの Chrome は Bun が自動で見つけます。見つからないときは `BUN_CHROME_PATH`
    に実行ファイルのパスを入れるか、`PLAYWRIGHT_BROWSERS_PATH` を Playwright のインストール先に向けるとその Chromium を使います。

## セットアップ

1. インストールします。

   ```sh
   bun add -d bun-webview-test
   ```

2. `bunfig.toml` に preload を足します。preload は `expect.element` を足し、テストごとにページを戻し、ページ内の未捕捉例外で
   テストを落とし、最後にブラウザを閉じます。

   ```toml
   [test]
   preload = ["bun-webview-test/preload"]
   ```

3. 設定を変えたいときは、自分の preload を作ります（任意）。

   ```ts
   // test/setup.ts  （bunfig.toml の preload に "./test/setup.ts" を書く）
   import { configure } from "bun-webview-test";
   import "bun-webview-test/preload";

   configure({ width: 375, height: 812, expectTimeout: 2000, publicDir: "./public" });
   ```

ブラウザは最初に `page` を触ったときに 1 回だけ起動し、全テストファイルで使い回します（Chrome の起動は 1 秒ほど、以後のページリセットは数十 ms）。ブラウザを使わないテストには何のコストもかかりません。

たくさんのテストファイルを動かすときは `bun test --parallel --no-isolate` がいちばん速くなります。vitest のブラウザモードと同じく、ブラウザで動くテストはファイルごとに新しいページで動くので、Bun 側の global を作り直さなくてもテスト同士は分離されています（`--isolate` で増えるのは、Bun 側の `mock` などの状態の分離です）。

`bun test --parallel`（と `--isolate`）でも使えます。Chrome はワーカーのプロセスごとに 1 回だけ起動し、ファイルごとに global が作り直されても使い回します（プロセスが終わると止まります）。この使い回しをやめたいときは `BWT_SHARED_CHROME=0` にします。

### 設定

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

### vitest と同じに動くもの

vitest v5.0.3 の `test/browser`（テスト・fixtures・specs）をこのパッケージに移植してあり、すべて通ります。

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
