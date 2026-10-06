export interface BrowserConfig {
  /**
   * "webkit" は macOS のみ。既定は macOS なら "webkit"、それ以外は "chrome"。
   * 環境変数 BWT_BACKEND でも上書きできる。
   */
  backend: "webkit" | "chrome";
  /** Chrome の実行ファイル。未指定なら BUN_CHROME_PATH か Bun の自動検出。 */
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

/** BUN_CHROME_PATH、なければ Playwright が入れた Chromium（PLAYWRIGHT_BROWSERS_PATH）を使う。 */
export function detectChromePath(): string | undefined {
  if (process.env.BUN_CHROME_PATH) return process.env.BUN_CHROME_PATH;
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!dir) return undefined;
  const glob = new Bun.Glob("chromium-*/chrome-linux*/chrome");
  for (const p of glob.scanSync({ cwd: dir, onlyFiles: true })) return `${dir}/${p}`;
  return undefined;
}

function defaults(): BrowserConfig {
  const env = process.env.BWT_BACKEND;
  const backend = env === "webkit" || env === "chrome" ? env : process.platform === "darwin" ? "webkit" : "chrome";
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
