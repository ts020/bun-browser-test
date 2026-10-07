import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserCacheRoot, installedHeadlessShell } from "./browser-binary";

export interface BrowserConfig {
  /**
   * 既定は全 OS で "chrome"（Headless Shell）。"webkit" は macOS のみ。
   * 環境変数 BWT_BACKEND でも上書きできる。
   */
  backend: "webkit" | "chrome";
  /** 実行ファイル。未指定なら BUN_CHROME_PATH、次にインストール済みの Headless Shell。 */
  chromePath?: string;
  /** Chrome に追加で渡す引数。root で動かすときは --no-sandbox を自動で足す。 */
  chromeArgs: string[];
  width: number;
  height: number;
  /** ページの console.* を Bun のコンソールに流す。 */
  forwardConsole: boolean;
  /** 静的ファイルを配信するディレクトリ。page.goto("/foo.html") で開ける。 */
  publicDir?: string;
  /** locator 操作が要素を待つ時間 (ms)。 */
  actionTimeout: number;
  /** expect.element がリトライする時間 (ms)。 */
  expectTimeout: number;
  /** ページ内で捕まらなかった例外があればテストを失敗させる。 */
  failOnPageError: boolean;
  /** 毎テストの前にまっさらなページへ戻す。 */
  resetBetweenTests: boolean;
}

/** 明示指定、専用キャッシュ、既存の Playwright インストールの順で探す。 */
export function detectChromePath(): string | undefined {
  if (process.env.BUN_CHROME_PATH) return process.env.BUN_CHROME_PATH;
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const managed = process.env.BWT_BROWSERS_PATH || process.env.BWT_BROWSER_VERSION;
  if (managed || !configured) {
    const installed = installedHeadlessShell();
    if (installed || managed) return installed;
  }
  // Playwright の hermetic install はそのパッケージ内にあるため、自動探索しない。
  if (configured === "0") return undefined;
  const dir = configured ? resolve(configured) : join(browserCacheRoot(), "ms-playwright");
  if (!existsSync(dir)) return undefined;
  const layout = process.platform === "darwin" ? "*mac*" : process.platform === "win32" ? "*win*" : "*linux*";
  const glob = new Bun.Glob(`chromium_headless_shell-*/${layout}/*`);
  const paths = [...glob.scanSync({ cwd: dir, onlyFiles: true })].filter((p) =>
    /(?:^|[/\\])(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/.test(p),
  );
  // 複数のインストールがある場合も、ファイルシステムの列挙順に依存させない。
  paths.sort((a, b) => Number(b.match(/chromium_headless_shell-(\d+)/)?.[1] ?? 0)
    - Number(a.match(/chromium_headless_shell-(\d+)/)?.[1] ?? 0) || a.localeCompare(b));
  return paths[0] ? join(dir, paths[0]) : undefined;
}

function defaults(): BrowserConfig {
  const env = process.env.BWT_BACKEND;
  const backend = env === "webkit" ? "webkit" : "chrome";
  const isRoot = process.getuid?.() === 0;
  return {
    backend,
    chromePath: detectChromePath(),
    chromeArgs: isRoot ? ["--no-sandbox"] : [],
    width: 1280,
    height: 720,
    forwardConsole: true,
    actionTimeout: 3000,
    expectTimeout: 1000,
    failOnPageError: true,
    resetBetweenTests: true,
  };
}

let current = defaults();

/** preload などで一度だけ呼ぶ。ブラウザ起動後に変えた値は次の起動から効く。 */
export function configure(patch: Partial<BrowserConfig>): BrowserConfig {
  current = { ...current, ...patch };
  return current;
}

export function getConfig(): BrowserConfig {
  return current;
}
