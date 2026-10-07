import type { BrowserBackend } from "../config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";

/** ブラウザ内で動くテストファイルから呼べる、Bun 側のコマンド。vitest の `browser.commands` と同じ形。 */
export type BrowserCommand = (context: BrowserCommandContext, ...args: any[]) => unknown;

export interface BrowserCommandContext {
  testPath: string | undefined;
  /** 生の Bun.WebView。Firefox でアクセスすると非対応エラー。 */
  view: InstanceType<typeof Bun.WebView>;
}

export interface BrowserModeConfig {
  /** Browser engine. BWT_BACKEND overrides this setting. */
  backend: BrowserBackend;
  /** Regular Firefox executable (WebDriver BiDi). BWT_FIREFOX_PATH overrides this setting. */
  firefoxPath?: string;
  /** Additional Firefox launch arguments. */
  firefoxArgs: string[];
  /**
   * ブラウザで動かすテストファイル。既定は「`vitest/browser` か `@vitest/browser/context` を import している」
   * または「ファイル名が `.browser.test.*` / `.browser.spec.*`」のファイル。
   */
  include: RegExp | ((path: string, source: string) => boolean);
  /** vitest の `test.root`。fs コマンドや import.meta.env の基準。既定は process.cwd() */
  root: string;
  /** vitest の `test.setupFiles`（ブラウザ内で各テストファイルの前に読み込む） */
  setupFiles: string[];
  testTimeout: number;
  hookTimeout: number;
  /** vitest の `browser.viewport`。既定は vitest と同じ 414x896 */
  viewport: { width: number; height: number };
  locators: { testIdAttribute: string; exact: boolean; errorFormat: "html" | "aria" | "all" };
  /** Playwright プロバイダーの `actionTimeout` に相当 */
  actionTimeout: number | undefined;
  commands: Record<string, BrowserCommand>;
  /** vitest の `test.env` / import.meta.env に入る値 */
  env: Record<string, string>;
  /** Bun.build の define。vitest の `define` 相当 */
  define: Record<string, string>;
  allowOnly: boolean;
  clearMocks: boolean;
  mockReset: boolean;
  restoreMocks: boolean;
  unstubGlobals: boolean;
  unstubEnvs: boolean;
  maxConcurrency: number;
  retry: number;
  expect: { requireAssertions?: boolean; poll?: { timeout?: number; interval?: number } };
  /** `server.provider` が返す名前。テストの分岐を Playwright と同じにするため既定は "playwright" */
  provider: string;
  /** `server.browser` が返す名前。既定は chrome なら "chromium"、それ以外はバックエンド名 */
  browserName?: string;
  /** スナップショットの更新。既定は `bun test -u` / `--update-snapshots` のときだけ "all"、それ以外は "new" */
  updateSnapshot: "all" | "new" | "none";
  /** ページの console.* を Bun の標準出力に流す */
  forwardConsole: boolean;
  /** Vite の `resolve.alias` 相当（前方一致で置き換える） */
  alias: Record<string, string>;
  /** `import.meta.env` に入れる .env の変数の接頭辞。Vite と同じく既定は "VITE_" */
  envPrefix: string | string[];
  /** Vite の `optimizeDeps`。include に書いたものは node_modules の外にあっても事前バンドルする（CommonJS のローカルパッケージなど） */
  optimizeDeps: { include?: string[] };
  /** Vite の `server` 設定の一部。テストのページを配信するサーバーの振る舞い */
  server: {
    /** すべての応答に付けるヘッダー（Vite の `server.headers`） */
    headers?: Record<string, string>;
    /** Vite の `configureServer` で足すミドルウェアに相当。Response を返せばそれが応答になる */
    middleware?: (req: Request) => Response | undefined | Promise<Response | undefined>;
    /** Vite の `server.fs.allow`。省略時はワークスペースのルート（Vite の searchForWorkspaceRoot と同じ） */
    fs?: { allow?: string[] };
  };
  /** vitest の `browser.expect.toMatchScreenshot`（comparatorName, comparatorOptions, comparators, screenshotDirectory, resolveScreenshotPath など） */
  toMatchScreenshot?: Record<string, any>;
  /** vitest の `browser.screenshotDirectory` */
  screenshotDirectory?: string;
  /** vitest の `attachmentsDir`。toMatchScreenshot の差分画像や失敗時のスクリーンショットの置き場所 */
  attachmentsDir: string;
  /** vitest の `browser.trackUnhandledErrors`。false なら未捕捉エラーで失敗させない */
  trackUnhandledErrors?: boolean;
  /** vitest の `onUnhandledError`。false を返すとそのエラーは無視される */
  onUnhandledError?: (error: { name?: string; message: string; stack?: string }, type: string) => boolean | void;
  /** vitest の `browser.screenshotFailures`。テストが失敗したらページのスクリーンショットを残す（既定 true） */
  screenshotFailures: boolean;
  /** vitest の `browser.testerHtmlPath`。テストを動かすページの HTML（root からの相対パス） */
  testerHtmlPath?: string;
  /** vitest の `browser.headless`。Firefox 以外の Bun.WebView は常にヘッドレス */
  headless: boolean;
}

/** テストファイルの上の階層にあるこの名前のファイルが、そのディレクトリ以下の設定になる（vitest の projects に相当）。 */
export const PROJECT_CONFIG_FILES = ["bwt.config.ts", "bwt.config.js", "bwt.config.mjs"];

export type ProjectConfig = Partial<Omit<BrowserModeConfig, "viewport" | "locators">> & {
  viewport?: Partial<BrowserModeConfig["viewport"]>;
  locators?: Partial<BrowserModeConfig["locators"]>;
};

const isCI = !!process.env.CI;

function defaults(): BrowserModeConfig {
  const update = process.argv.some((a) => a === "-u" || a === "--update-snapshots");
  return {
    backend: "chrome",
    firefoxArgs: [],
    include: (path, source) =>
      /\.browser\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
      /from\s+['"](vitest\/browser|@vitest\/browser\/context)['"]/.test(source),
    root: process.cwd(),
    setupFiles: [],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    viewport: { width: 414, height: 896 },
    locators: { testIdAttribute: "data-testid", exact: false, errorFormat: "all" },
    actionTimeout: undefined,
    commands: {},
    env: {},
    define: {},
    allowOnly: !isCI,
    clearMocks: true,
    mockReset: false,
    restoreMocks: false,
    unstubGlobals: false,
    unstubEnvs: false,
    maxConcurrency: 5,
    retry: 0,
    expect: {},
    provider: "playwright",
    updateSnapshot: update ? "all" : isCI ? "none" : "new",
    forwardConsole: true,
    alias: {},
    server: {},
    optimizeDeps: {},
    attachmentsDir: ".vitest/attachments",
    screenshotFailures: true,
    envPrefix: "VITE_",
    headless: true,
  };
}

let current = defaults();

/** preload で呼ぶ。テストファイルを読み込む前に設定しておくこと。 */
export function configureBrowserMode(patch: Partial<BrowserModeConfig>): BrowserModeConfig {
  current = { ...current, ...patch };
  if (patch.root) current.root = resolve(patch.root);
  return current;
}

export function getBrowserModeConfig(): BrowserModeConfig {
  return current;
}

/** vitest の設定ファイルのように書けるよう、型を付けるだけの関数。 */
export function defineConfig(config: ProjectConfig): ProjectConfig {
  return config;
}

function merge(base: BrowserModeConfig, patch: ProjectConfig, dir: string): BrowserModeConfig {
  return {
    ...base,
    ...(patch as Partial<BrowserModeConfig>),
    root: patch.root ? resolve(dir, patch.root) : dir,
    // bwt.config.* のあるディレクトリのテストは、指定がなければすべてブラウザで動かす
    include: patch.include ?? (() => true),
    viewport: { ...base.viewport, ...patch.viewport },
    locators: { ...base.locators, ...patch.locators },
    commands: { ...base.commands, ...patch.commands },
    env: { ...base.env, ...patch.env },
    define: { ...base.define, ...patch.define },
    alias: { ...base.alias, ...patch.alias },
    server: { ...base.server, ...patch.server },
    optimizeDeps: { include: [...(base.optimizeDeps.include ?? []), ...(patch.optimizeDeps?.include ?? [])] },
    expect: { ...base.expect, ...patch.expect },
  };
}

/**
 * 環境変数 BWT_CONFIG（JSON）で設定を上書きする。vitest の CLI オプション（--browser.locators.errorFormat=aria など）の代わり。
 * オブジェクトは 1 段だけ重ねる。
 */
function withEnvOverrides(c: BrowserModeConfig): BrowserModeConfig {
  const raw = process.env.BWT_CONFIG;
  if (!raw) return c;
  const patch = JSON.parse(raw) as Record<string, unknown>;
  const out: any = { ...c };
  for (const [key, value] of Object.entries(patch)) {
    const base = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && base && typeof base === "object" && !Array.isArray(base)
        ? { ...base, ...value }
        : value;
  }
  return out;
}

const projectCache = new Map<string, Promise<ProjectConfig>>();

/** テストファイルに効く設定。いちばん近い bwt.config.* があればそれを重ねる。 */
export async function resolveFileConfig(filepath: string): Promise<BrowserModeConfig> {
  const stop = parse(filepath).root;
  for (let dir = dirname(filepath); ; dir = dirname(dir)) {
    for (const name of PROJECT_CONFIG_FILES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      let loaded = projectCache.get(file);
      if (!loaded) {
        loaded = import(file).then((m) => (typeof m.default === "function" ? m.default() : m.default) ?? {});
        projectCache.set(file, loaded);
      }
      return withEnvOverrides(merge(current, await loaded, dir));
    }
    if (dir === stop) return withEnvOverrides(current);
  }
}

/** Vite と同じく root の .env / .env.local / .env.test / .env.test.local から接頭辞の付いた変数を読む。 */
export function loadEnvFiles(c: BrowserModeConfig): Record<string, string> {
  const prefixes = Array.isArray(c.envPrefix) ? c.envPrefix : [c.envPrefix];
  const env: Record<string, string> = {};
  for (const name of [".env", ".env.local", ".env.test", ".env.test.local"]) {
    const file = join(c.root, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let value = m[2]!;
      if (/^(['"`]).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      if (prefixes.some((p) => m[1]!.startsWith(p))) env[m[1]!] = value;
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && prefixes.some((p) => k.startsWith(p))) env[k] = v;
  }
  return env;
}

/** ページ側に渡す vitest の SerializedConfig。 */
export function serializeConfig(c: BrowserModeConfig, browserName: string): Record<string, unknown> {
  return {
    root: c.root,
    setupFiles: c.setupFiles.map((f) => resolve(c.root, f)),
    // vitest はインスタンスが 1 つのとき、プロジェクト名をブラウザ名（"chromium" など）にする
    name: browserName,
    passWithNoTests: false,
    testNamePattern: undefined,
    allowOnly: c.allowOnly,
    sequence: { shuffle: false, concurrent: false, seed: Date.now(), hooks: "stack", setupFiles: "parallel" },
    maxConcurrency: c.maxConcurrency,
    testTimeout: c.testTimeout,
    hookTimeout: c.hookTimeout,
    retry: c.retry,
    repeats: undefined,
    includeTaskLocation: false,
    tags: [],
    tagsFilter: undefined,
    strictTags: false,
    globals: false,
    injectCjsGlobals: false,
    base: "/",
    disableConsoleIntercept: true,
    runner: undefined,
    isolate: true,
    maxWorkers: 1,
    bail: undefined,
    environmentOptions: {},
    clearMocks: c.clearMocks,
    mockReset: c.mockReset,
    restoreMocks: c.restoreMocks,
    unstubGlobals: c.unstubGlobals,
    unstubEnvs: c.unstubEnvs,
    fakeTimers: { loopLimit: 10_000, shouldClearNativeTimers: true },
    defines: {},
    expect: c.expect,
    printConsoleTrace: false,
    deps: { web: {}, optimizer: {}, interopDefault: true, moduleDirectories: ["node_modules"] },
    snapshotOptions: { updateSnapshot: c.updateSnapshot, expand: false, snapshotFormat: {}, snapshotEnvironment: null },
    pool: "browser",
    snapshotSerializers: [],
    chaiConfig: undefined,
    taskTitleValueFormatTruncate: 40,
    api: { allowExec: false, allowWrite: true },
    diff: undefined,
    inspect: false,
    inspectBrk: false,
    inspector: {},
    watch: false,
    env: { ...c.env },
    browser: {
      name: browserName,
      headless: c.headless,
      ui: false,
      viewport: c.viewport,
      locators: c.locators,
      screenshotFailures: c.screenshotFailures,
      providerOptions: { actionTimeout: c.actionTimeout },
      trace: "off",
      traceView: { enabled: false, recordCanvas: false, inlineImages: false },
      trackUnhandledErrors: true,
      detailsPanelPosition: "right",
    },
    standalone: false,
    logHeapUsage: false,
    detectAsyncLeaks: false,
    coverage: {
      provider: undefined,
      reportsDirectory: "",
      coverageFilesDirectory: "",
      htmlDir: undefined,
      enabled: false,
      customProviderModule: undefined,
      autoAttachSubprocess: false,
    },
    benchmark: { enabled: false, retainSamples: false, provider: undefined, suppressExportGetterWarnings: false, projectName: "" },
    serializedDefines: "",
    fsModuleCache: false,
    experimental: {
      importDurations: { print: false, limit: 0, failOnDanger: false, thresholds: { warn: 0, danger: 0 } },
      viteModuleRunner: false,
      nodeLoader: false,
      openTelemetry: undefined,
    },
    mergeReportsLabel: undefined,
    slowTestThreshold: 300,
    disableColors: false,
    attachmentsDir: resolve(c.root, c.attachmentsDir),
  };
}

const WORKSPACE_FILES = ["pnpm-workspace.yaml", "lerna.json", "bun.lock", "bun.lockb"];

/** Vite の searchForWorkspaceRoot と同じ考え方で、ファイルを読み書きしてよい範囲の根を探す。 */
export function searchForWorkspaceRoot(root: string): string {
  let found = root;
  for (let dir = root; ; ) {
    if (WORKSPACE_FILES.some((f) => existsSync(join(dir, f)))) return dir;
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf-8")).workspaces) return dir;
      } catch {}
      found = found === root ? dir : found;
    }
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/** vitest の checkFileAccess / assertBrowserFileAccess に相当。 */
export function assertFileAccess(config: BrowserModeConfig, path: string): void {
  const allow = config.server.fs?.allow?.map((p) => resolve(config.root, p)) ?? [searchForWorkspaceRoot(config.root)];
  const target = resolve(path);
  if (allow.some((dir) => target === dir || target.startsWith(dir.endsWith(sep) ? dir : dir + sep))) return;
  throw new Error(
    `Access denied to "${path}". See Vite config documentation for "server.fs": https://vitejs.dev/config/server-options.html#server-fs-strict.`,
  );
}
