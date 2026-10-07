// Bun 側。テストファイルごとに新しい document でテストを実行し、
// 結果を bun test の describe / test として報告する。

import { afterAll, describe, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildRuntime, importMap } from "./bundler";
import { chromeBackend } from "../chrome";
import { detectChromePath, resolveBackend, type BrowserBackend } from "../config";
import { FirefoxView } from "./firefox";
import { assertFileAccess, type BrowserModeConfig, getBrowserModeConfig, loadEnvFiles, resolveFileConfig, serializeConfig } from "./config";
import { CDP_EVENTS } from "./cdp-events";
import { decode, encode } from "./codec";
import { DevServer, IMPORT_HELPERS } from "./devserver";
import { Input } from "./input";
import { screenshotMatcher } from "./screenshot-matcher";

type WebView = InstanceType<typeof Bun.WebView>;

// ---- 共有サーバー ----

const sessions = new Map<string, FileSession>();
let server: ReturnType<typeof Bun.serve> | null = null;
let seq = 0;
const DEBUG = !!process.env.BWT_DEBUG;
// --no-isolate ではワーカー内で Chrome のタブを再利用する。document は毎回読み直す。
let idleChrome: { key: string; view: WebView } | undefined;
process.on("exit", () => idleChrome?.view.close());

function getServer() {
  server ??= Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: handle,
  });
  return server;
}

function mimeOf(path: string): string {
  return Bun.file(path).type || "application/octet-stream";
}

async function handle(req: Request): Promise<Response> {
  const res = await route(req);
  // Vite の server.headers と同じく、テストのページやファイルの応答にヘッダーを付ける
  if (!new URL(req.url).pathname.startsWith("/__bwt/rpc/")) {
    for (const s of sessions.values()) {
      for (const [k, v] of Object.entries(s.config.server.headers ?? {})) res.headers.set(k, v);
    }
  }
  return res;
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (DEBUG) console.error("[bwt http]", req.method, url.pathname);
  const { pathname } = url;
  const rpcMatch = /^\/__bwt\/rpc\/([^/]+)$/.exec(pathname);
  if (rpcMatch && req.method === "POST") {
    const session = sessions.get(rpcMatch[1]!);
    if (!session) return Response.json({ error: { message: "unknown session" } });
    const { method, args } = decode(await req.json()) as { method: string; args: unknown[] };
    if (DEBUG) console.error("[bwt rpc]", method, JSON.stringify(args).slice(0, Number(process.env.BWT_DEBUG) > 1 ? 1e6 : 300));
    try {
      const result = await session.rpc(method, args);
      return new Response(JSON.stringify({ result: encode(result) }), { headers: { "content-type": "application/json" } });
    } catch (e: any) {
      return Response.json({ error: { name: e?.name, message: e?.message ?? String(e) } });
    }
  }
  const pageMatch = /^\/__bwt\/(page|tester)\/([^/]+)$/.exec(pathname);
  if (pageMatch) {
    const session = sessions.get(pageMatch[2]!);
    if (!session) return new Response("not found", { status: 404 });
    const body = pageMatch[1] === "page" ? session.orchestratorHtml(!url.searchParams.has("idle")) : session.html();
    return new Response(body, { headers: { "content-type": "text/html;charset=utf-8" } });
  }
  if (pathname.startsWith("/__bwt/rt/")) {
    const rt = await buildRuntime();
    const out = rt.get(pathname);
    // このサーバーの生存中は不変。テストやユーザーのソースにはこのキャッシュを適用しない。
    if (out) return new Response(out.body, { headers: { "content-type": out.type, "cache-control": "public, max-age=31536000, immutable" } });
  }
  if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (pathname === "/__bwt/resolve") {
    // 文字列でない import(...) の解決（devserver.ts の __bwt_import__）
    const session = sessions.get(url.searchParams.get("session") ?? "");
    if (!session) return new Response("unknown session", { status: 404 });
    return Response.json(await session.devServer.resolveDynamic(url.searchParams.get("spec")!, url.searchParams.get("importer")!));
  }
  for (const s of new Set([...sessions.values()].map((s) => s.config.server.middleware))) {
    const res = await s?.(req);
    if (res) return res;
  }

  // ソースのモジュールは変換して配信する
  for (const dev of new Set([...sessions.values()].map((s) => s.devServer))) {
    try {
      const res = await dev.load(pathname, url.search);
      if (res) return res;
    } catch (err: any) {
      // 200 で返さないとブラウザは理由の分からない「読み込めなかった」エラーにしてしまう
      return new Response(`throw new Error(${JSON.stringify(err?.message ?? String(err))});`, {
        headers: { "content-type": "text/javascript" },
      });
    }
  }

  // それ以外は Vite と同じくプロジェクトのルートからファイルを配信する（/@fs/ は絶対パス）
  if (pathname.startsWith("/@fs/")) {
    const path = decodeURIComponent(pathname.slice(4));
    const file = Bun.file(path);
    if (await file.exists()) return new Response(file, { headers: { "content-type": mimeOf(path) } });
  }
  const roots = new Set([...[...sessions.values()].map((s) => s.config.root), getBrowserModeConfig().root]);
  for (const root of roots) {
    const path = join(root, decodeURIComponent(pathname));
    if (!path.startsWith(root)) continue;
    const file = Bun.file(path);
    if (await file.exists()) return new Response(file, { headers: { "content-type": mimeOf(path) } });
  }
  return new Response("not found", { status: 404 });
}

const devServers = new Map<string, DevServer>();

function getDevServer(config: BrowserModeConfig): DevServer {
  let dev = devServers.get(config.root);
  if (!dev) {
    dev = new DevServer(config);
    devServers.set(config.root, dev);
  }
  return dev;
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---- タスクの結果 ----

interface SerializedTask {
  id: string;
  name: string;
  type: "suite" | "test";
  mode: "run" | "skip" | "only" | "todo";
  fails?: boolean;
  timeout?: number;
  result?: TaskResult;
  tasks?: SerializedTask[];
}

interface TaskResult {
  state: "pass" | "fail" | "skip" | "todo" | "run" | "queued";
  errors?: SerializedError[];
}

interface SerializedError {
  name?: string;
  message?: string;
  stack?: string;
  stackStr?: string;
  diff?: string;
  cause?: SerializedError;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const ANSI = /\u001b\[[0-9;]*m/g;

function toError(err: SerializedError): Error {
  // Bun がこのファイルの行を「失敗した場所」として表示しないよう、スタックを取らずに作る
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  const e = new Error();
  Error.stackTraceLimit = limit;
  e.name = err.name || "Error";
  let message = err.message ?? "";
  if (err.diff) message += `\n\n${err.diff}`;
  // ページ内のスタックはソースマップで元のファイルに戻してある。ランタイム（/__bwt/）の行は省く
  const frames = (err.stack ?? err.stackStr ?? "")
    .split("\n")
    .map((l) => {
      const firefox = /^(.*?)@(.+:\d+:\d+)$/.exec(l);
      return firefox ? `    at ${firefox[1] || "<anonymous>"} (${firefox[2]})` : l;
    })
    .filter((l) => /^\s+at /.test(l) && !l.includes("/__bwt/rt/") && !l.includes("(<anonymous>)"));
  if (frames.length) message += `\n\n${frames.map((f) => `  ${f.trim()}`).join("\n")}`;
  // Bun は cause を表示しないので、メッセージに足す
  for (let cause = err.cause; cause; cause = cause.cause) {
    message += `\n\nCaused by: ${cause.name ?? "Error"}: ${cause.message ?? ""}`;
  }
  // 未捕捉エラーには、vitest の printError と同じく起きたときのテストを添える
  const testPath = (err as any).VITEST_TEST_PATH as string | undefined;
  const testName = (err as any).VITEST_TEST_NAME as string | undefined;
  if (testPath) {
    message += `\n\nThis error originated in "${testPath}" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.`;
  }
  if (testName) {
    message +=
      `\nThe last test to run before this error was "${testName}". This means either:` +
      "\n- the error was thrown while Vitest was running this test, or" +
      "\n- the error was thrown after the test completed, and this was the most recent test at that point.";
  }
  e.message = message;
  e.stack = `${e.name}: ${message}`;
  return e;
}

function combine(errors: SerializedError[]): Error {
  if (errors.length === 1) return toError(errors[0]!);
  const all = errors.map(toError);
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  const e = new Error(all.map((x, i) => `[${i + 1}/${all.length}] ${x.name}: ${x.message}`).join("\n\n"));
  Error.stackTraceLimit = limit;
  e.stack = `Error: ${e.message}`;
  return e;
}

// ---- ページの console ----

/** CDP の RemoteObject（Runtime.consoleAPICalled の引数）を Bun の console で表示できる値に戻す。 */
function fromRemoteObject(arg: any): unknown {
  if (!arg || typeof arg !== "object" || typeof arg.type !== "string" || !("objectId" in arg || "value" in arg || "description" in arg)) {
    return arg;
  }
  if ("value" in arg) return arg.value;
  if (arg.type === "undefined") return undefined;
  if (arg.subtype === "error") {
    // vitest と同じく、スタックの無い [Error: message] の形で出す
    const first = String(arg.description ?? "").split("\n")[0];
    return { [Bun.inspect.custom]: () => `[${first}]` };
  }
  if (arg.preview?.properties && (arg.subtype === "array" || arg.type === "object")) {
    const props = arg.preview.properties as { name: string; value?: string; type: string }[];
    const fromProp = (p: { value?: string; type: string }) =>
      p.type === "number" ? Number(p.value) : p.type === "boolean" ? p.value === "true" : p.type === "undefined" ? undefined : p.value;
    if (arg.subtype === "array") return props.map(fromProp);
    return Object.fromEntries(props.map((p) => [p.name, fromProp(p)]));
  }
  return arg.description ?? arg.unserializableValue ?? arg;
}

function pageConsole(type: string, ...args: unknown[]) {
  const fn = (console as any)[type];
  (typeof fn === "function" ? fn : console.log).apply(console, args.map(fromRemoteObject));
}

// ---- テストファイル 1 本分 ----

class FileSession {
  readonly id = `f${++seq}`;
  config: BrowserModeConfig;
  view!: WebView | FirefoxView;
  input!: Input | FirefoxView["input"];
  backend: BrowserBackend = "chrome";
  devServer!: DevServer;
  readonly collected = deferred<SerializedTask[]>();
  readonly finished = deferred<void>();
  private results = new Map<string, TaskResult>();
  readonly failureScreenshots = new Map<string, string[]>();
  private parents = new Map<string, string>();
  readonly unhandled: SerializedError[] = [];
  private cdpListening = new Set<string>();
  private testerHtml: string | null = null;
  private chromeKey = "";
  private reusable = true;

  constructor(readonly filepath: string) {
    this.config = getBrowserModeConfig();
  }

  get browserName() {
    return this.config.browserName ?? (this.backend === "chrome" ? "chromium" : this.backend);
  }

  private get webView(): WebView {
    if (this.view instanceof FirefoxView) {
      throw new Error("CDP and raw Bun.WebView access are not supported by the firefox backend. Use the chrome backend for these operations.");
    }
    return this.view;
  }

  /**
   * vitest のオーケストレーターに相当するページ。テストは vitest と同じく iframe（ビューポートの大きさ）の中で動く。
   * Bun 側からの evaluate はこのページで動くので、テスター側のグローバルを転送しておく。
   */
  orchestratorHtml(tester = true): string {
    const { width, height } = this.config.viewport;
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Vitest Browser Runner</title>
<style>
:root { --viewport-width: ${width}px; --viewport-height: ${height}px; }
html, body { margin: 0; padding: 0; overflow: hidden; }
iframe { display: block; border: none; background-color: #fff; width: var(--viewport-width); height: var(--viewport-height); }
</style>
</head>
<body>
${tester ? `<iframe id="vitest-tester" data-vitest="true" loading="eager" src="/__bwt/tester/${this.id}"></iframe>` : ""}
<script>
for (const name of ["__bwt_tester__", "__vitest_browser_runner__", "__bwt_early_errors__"]) {
  Object.defineProperty(window, name, { get: () => document.getElementById("vitest-tester")?.contentWindow[name] });
}
</script>
</body>
</html>`;
  }

  html(): string {
    const origin = getServer().url.origin;
    const entry = (filepath: string) => ({
      filepath,
      url: origin + (isAbsolute(filepath) ? this.devServer.fileUrl(filepath) : this.devServer.depUrl(filepath)),
    });
    const boot = {
      config: {
        ...serializeConfig(this.config, this.browserName),
        setupFiles: this.setupFilePaths(),
        testNamePattern: testNamePattern(),
      },
      sessionId: this.id,
      rpcUrl: `${origin}/__bwt/rpc/${this.id}`,
      platform: process.platform,
      version: process.version,
      provider: this.config.provider,
      backend: this.backend,
      commands: Object.keys(this.config.commands),
      testFile: entry(this.filepath),
      setupFiles: this.setupFilePaths().map(entry),
      metaEnv: loadEnvFiles(this.config),
    };
    const head = `<script>window.__bwt_boot__ = ${JSON.stringify(boot).replace(/</g, "\\u003c")};
window.__bwt_early_errors__ = [];
addEventListener("error", (e) => __bwt_early_errors__.push(String(e.error && e.error.stack || e.message)));</script>
<script type="importmap">${importMap()}</script>
<script>${IMPORT_HELPERS}
window.__bwt_import__ = (spec, importer) => {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/__bwt/resolve?session=${this.id}&spec=" + encodeURIComponent(spec) + "&importer=" + encodeURIComponent(importer), false);
  xhr.send();
  const r = JSON.parse(xhr.responseText);
  if (r.error) return Promise.reject(new Error(r.error));
  return import(r.url).then((m) => (r.dep ? (r.cjs ? __bwt_cjs_ns__(m.default) : m.default) : m));
};</script>
${this.devServer.depCss.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n")}`;
    // グローバル（__vitest_browser_runner__ など）を先に用意する。分割したチャンクの評価順に左右されないよう別エントリにしている
    const scripts = `<script type="module" src="/__bwt/rt/state.js"></script>
<script type="module" src="/__bwt/rt/tester.js"></script>`;
    if (this.testerHtml != null) {
      // vitest の browser.testerHtmlPath。<head> の先頭に起動情報、末尾にテスターを入れる
      return this.testerHtml.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`).replace(/<\/head>/i, `${scripts}\n</head>`);
    }
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vitest Browser Tester</title>
<style>
html {
  padding: 0;
  margin: 0;
}
body {
  padding: 0;
  margin: 0;
  min-height: 100vh;
}
</style>
${head}
${scripts}
</head>
<body></body>
</html>`;
  }

  /** testerHtmlPath の HTML を読み、相対パスの module スクリプトを配信する URL に差し替える。 */
  private async loadTesterHtml(): Promise<string[]> {
    const path = resolve(this.config.root, this.config.testerHtmlPath!);
    let html = await Bun.file(path).text();
    const re = /<script([^>]*)\ssrc=(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi;
    const modules: string[] = [];
    html = html.replace(re, (all, before: string, _q: string, src: string, after: string) => {
      if (!/type=["']module["']/.test(before + after) || /^(https?:)?\/\//.test(src)) return all;
      const file = src.startsWith("/") ? join(this.config.root, src) : resolve(dirname(path), src);
      modules.push(file);
      return `<script type="module" src="${this.devServer.fileUrl(file)}"></script>`;
    });
    this.testerHtml = html;
    return modules;
  }

  /** setupFiles をファイルのパスにする。パッケージ名（vitest-browser-react など）はそのまま残す。 */
  private setupFilePaths(): string[] {
    return this.config.setupFiles.map((f) => {
      const abs = resolve(this.config.root, f);
      if (existsSync(abs)) return abs;
      try {
        return Bun.resolveSync(abs, this.config.root);
      } catch {
        return f;
      }
    });
  }

  async start() {
    this.config = await resolveFileConfig(this.filepath);
    this.backend = resolveBackend(this.config.backend);
    const srv = getServer();
    this.devServer = getDevServer(this.config);
    const htmlModules = this.config.testerHtmlPath ? await this.loadTesterHtml() : [];
    // テストファイルから辿れるモジュールを先に変換し、node_modules の依存をまとめてバンドルしておく
    await Promise.all([buildRuntime(), this.devServer.prepare([this.filepath, ...this.setupFilePaths(), ...htmlModules])]);
    sessions.set(this.id, this);

    let reused = false;
    if (this.backend === "firefox") {
      idleChrome?.view.close();
      idleChrome = undefined;
      const view = await FirefoxView.start(this.config);
      this.view = view;
      this.input = view.input;
      void view.disconnected.then(error => {
        this.unhandled.push({ message: error.message });
        this.finished.resolve();
      });
    } else {
      const backend = this.backend === "webkit" ? "webkit" : await chromeBackend(chromePath(), process.getuid?.() === 0 ? ["--no-sandbox"] : []);
      this.chromeKey = JSON.stringify([backend, this.config.forwardConsole, this.config.server.headers]);
      const idle = idleChrome;
      idleChrome = undefined;
      reused = this.backend === "chrome" && idle?.key === this.chromeKey;
      if (!reused) idle?.view.close();
      const view = reused ? idle!.view : new Bun.WebView({
        backend,
        width: this.config.viewport.width,
        height: this.config.viewport.height,
        console: this.config.forwardConsole ? pageConsole : undefined,
      });
      this.view = view;
      if (!reused) serializeViewCalls(view);
      this.input = new Input(view, this.backend);
    }
    if (this.backend === "chrome") {
      // 初回だけ CDP セッションを作る。再利用時に空白ページへ移る必要はない。
      if (!reused) await this.view.navigate("about:blank");
      await this.setViewport(this.config.viewport.width, this.config.viewport.height);
      // ウィンドウがフォーカスされていなくても focus / blur イベントが起きるようにする
      await this.webView.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    }
    if (reused) {
      // 前のファイルの終了時に読み直した、新しいオーケストレーターにテスターを入れる。
      // 次のファイルのために外側の document をもう一度読み直す必要はない。
      const { width, height } = this.config.viewport;
      await this.view.evaluate(`(() => {
        history.replaceState(null, "", "/__bwt/page/${this.id}");
        document.documentElement.style.setProperty("--viewport-width", "${width}px");
        document.documentElement.style.setProperty("--viewport-height", "${height}px");
        const iframe = document.createElement("iframe");
        iframe.id = "vitest-tester";
        iframe.dataset.vitest = "true";
        iframe.src = "/__bwt/tester/${this.id}";
        document.body.append(iframe);
        return true;
      })()`);
    } else {
      // ページが読み込まれるとテスターが自分でテストを始める
      await this.view.navigate(`${srv.url.origin}/__bwt/page/${this.id}`);
    }
    if (DEBUG) {
      setTimeout(async () => {
        console.error("[bwt debug]", await this.view.evaluate("JSON.stringify({t: typeof __bwt_tester__, e: __bwt_early_errors__})"));
      }, 2000);
    }
  }

  private cdpQueue: Promise<unknown> = Promise.resolve();

  private listenCdp(event: string) {
    const view = this.webView;
    if (this.cdpListening.has(event)) return;
    this.cdpListening.add(event);
    view.addEventListener(event, ((e: MessageEvent) => {
      const code = `(__vitest_browser_runner__.cdp.emit(${JSON.stringify(event)}, ${JSON.stringify(e.data)}), 1)`;
      // evaluate は同時に 1 つしか動かせないので順番に流す
      this.cdpQueue = this.cdpQueue.then(() => this.view.evaluate(code)).catch(() => {});
    }) as EventListener);
  }

  /** Playwright の page.setViewportSize と同じく、ウィンドウではなくページの表示領域の大きさを決める。 */
  async setViewport(width: number, height: number) {
    if (this.backend === "chrome") {
      await this.webView.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    } else {
      await this.view.resize(width, height);
    }
  }

  async close(reuse = false) {
    if (reuse && this.backend === "chrome" && this.reusable && !this.unhandled.length && this.input.isIdle) {
      try {
        // テスターのない新しい document へ移り、タイマー・iframe・JS の状態を破棄する。
        // タブ単位の状態も新規タブと同じに戻す。cookie / localStorage は従来どおり origin 単位。
        await this.view.navigate(`${getServer().url.origin}/__bwt/page/${this.id}?idle`);
        await this.view.evaluate('(sessionStorage.clear(), window.name = "", true)');
        await this.webView.cdp("Page.resetNavigationHistory");
        await this.webView.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
        idleChrome?.view.close();
        idleChrome = { key: this.chromeKey, view: this.webView };
        sessions.delete(this.id);
        return;
      } catch {
        // 閉じられたタブや後始末できないタブは再利用しない。
      }
    }
    sessions.delete(this.id);
    try {
      await this.view?.close();
    } catch {}
  }

  // ---- ページからの呼び出し ----

  async rpc(method: string, args: any[]): Promise<unknown> {
    switch (method) {
      case "onCollected": {
        const fileTasks = args[0] as SerializedTask[];
        const walk = (t: SerializedTask) => {
          for (const c of t.tasks ?? []) {
            this.parents.set(c.id, t.id);
            walk(c);
          }
        };
        fileTasks.forEach(walk);
        this.collected.resolve(fileTasks);
        return;
      }
      case "onTaskUpdate": {
        for (const [id, result] of args[0] as [string, TaskResult | undefined, unknown][]) {
          if (!result) continue;
          this.results.set(id, result);
        }
        return;
      }
      case "onUnhandledError": {
        // vitest の trackUnhandledErrors / onUnhandledError と同じ。false を返したエラーは無視する
        if (this.config.trackUnhandledErrors === false) return;
        if (this.config.onUnhandledError?.(args[0], args[1]) === false) return;
        if (args[0]?.VITEST_TEST_PATH) args[0].VITEST_TEST_PATH = relative(this.config.root, args[0].VITEST_TEST_PATH);
        this.unhandled.push(args[0]);
        return;
      }
      case "onFinished":
        this.finished.resolve();
        return;
      case "input":
        return this.runInput(args[0]);
      case "viewport":
        await this.setViewport(args[0], args[1]);
        return;
      case "cdp": {
        this.reusable = false;
        const result = await this.webView.cdp(args[0], args[1] ?? {});
        // ページが on() を登録するより先にイベントが来ても取りこぼさないよう、enable したドメインのイベントは全部流す
        const domain = /^(\w+)\.enable$/.exec(args[0])?.[1];
        for (const event of (domain && CDP_EVENTS[domain]) || []) this.listenCdp(`${domain}.${event}`);
        return result;
      }
      case "cdpListen":
        this.reusable = false;
        this.listenCdp(args[0]);
        return;
      case "fileInfo": {
        const path = resolve(this.config.root, args[0]);
        const file = Bun.file(path);
        return {
          content: Buffer.from(await file.arrayBuffer()).toString("base64"),
          basename: basename(path),
          mime: file.type.split(";")[0],
        };
      }
      case "screenshot":
        return this.screenshot(args[0], args[1]);
      case "command":
        return this.command(args[0], args[1], args[2]);
      case "failureScreenshot":
        this.failureScreenshots.set(args[0], [...(this.failureScreenshots.get(args[0]) ?? []), args[1]]);
        return;
      case "readSnapshotFile": {
        assertFileAccess(this.config, args[0]);
        const f = Bun.file(args[0]);
        return (await f.exists()) ? f.text() : null;
      }
      case "readSnapshotFileData": {
        assertFileAccess(this.config, args[0]);
        const f = Bun.file(args[0]);
        if (!(await f.exists())) return null;
        const data: Record<string, string> = Object.create(null);
        // スナップショットファイルは `exports[key] = value` の並び
        new Function("exports", await f.text())(data);
        return data;
      }
      case "saveSnapshotFile":
        assertFileAccess(this.config, args[0]);
        await mkdir(dirname(args[0]), { recursive: true });
        await writeFile(args[0], args[1], "utf-8");
        return;
      case "removeSnapshotFile":
        assertFileAccess(this.config, args[0]);
        await rm(args[0], { force: true });
        return;
      case "resolveSnapshotPath":
        return join(dirname(args[0]), "__snapshots__", `${basename(args[0])}.snap`);
      case "resolveSnapshotRawPath":
        return resolve(dirname(args[0]), args[1]);
      default:
        throw new Error(`Unknown rpc method: ${method}`);
    }
  }

  private async runInput(ops: any[]): Promise<void> {
    for (const op of ops) {
      switch (op[0]) {
        case "down":
          await this.input.keyDown(op[1]);
          break;
        case "up":
          await this.input.keyUp(op[1]);
          break;
        case "press":
          await this.input.press(op[1]);
          break;
        case "insertText":
          await this.input.insertText(op[1]);
          break;
        case "click":
          await this.input.click(op[1], op[2], op[3]);
          break;
        case "move":
          await this.input.mouseMove(op[1], op[2], op[3] ?? 1);
          break;
        case "mouseDown":
          await this.input.mouseDown(op[1] ?? "left");
          break;
        case "mouseUp":
          await this.input.mouseUp(op[1] ?? "left");
          break;
        case "wheel":
          await this.input.wheel(op[1], op[2]);
          break;
        case "modifiers":
          await this.input.ensureModifiers(op[1]);
          break;
        default:
          throw new Error(`Unknown input op ${op[0]}`);
      }
    }
  }

  /** vitest の resolveScreenshotPath と同じ場所。 */
  private screenshotPath(testPath: string, name: string, customPath?: string) {
    if (customPath) return resolve(dirname(testPath), customPath);
    const dir = dirname(testPath);
    if (this.config.screenshotDirectory) {
      return resolve(this.config.root, this.config.screenshotDirectory, relative(this.config.root, dir), basename(testPath), name);
    }
    return resolve(dir, "__screenshots__", basename(testPath), name);
  }

  private async capture(options: { clip?: Clip; type?: string; quality?: number; omitBackground?: boolean; fullPage?: boolean }) {
    if (this.view instanceof FirefoxView) return this.view.capture(options);
    if (this.backend !== "chrome") return this.view.screenshot({ encoding: "base64" }) as Promise<string>;
    const params: Record<string, unknown> = {
      format: options.type === "jpeg" ? "jpeg" : "png",
      captureBeyondViewport: !!options.clip || !!options.fullPage,
    };
    if (options.quality != null && options.type === "jpeg") params.quality = options.quality;
    if (options.clip) params.clip = { ...options.clip, scale: 1 };
    else if (options.fullPage) {
      const { cssContentSize } = await this.webView.cdp<{ cssContentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
      params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    }
    if (options.omitBackground) {
      await this.webView.cdp("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    try {
      const res = await this.webView.cdp<{ data: string }>("Page.captureScreenshot", params);
      return res.data;
    } finally {
      if (options.omitBackground) await this.webView.cdp("Emulation.setDefaultBackgroundColorOverride", {});
    }
  }

  /** ページ側で範囲を計算済みのスクリーンショット（locator.screenshot / page.screenshot）。 */
  private async screenshot(name: string, options: any) {
    const path = this.screenshotPath(options.testPath ?? this.filepath, name, options.path);
    const base64 = await this.capture(options);
    if (options.save) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(base64, "base64"));
    }
    return { path, base64 };
  }

  /** @vitest/browser-playwright の __vitest_takeScreenshot。toMatchScreenshot から呼ばれる。 */
  async takeScreenshot(testPath: string, name: string, options: any): Promise<{ buffer: Buffer; path: string }> {
    const path = this.screenshotPath(testPath, name, options.path);
    const { element, mask, target, style, animations, caret, maskColor, timeout, ...rest } = options;
    const prepared = (await this.view.evaluate(
      `__bwt_tester__.prepareScreenshot(${JSON.stringify({ element, mask, target, style, animations, caret, maskColor, timeout })})`,
    )) as { clip?: Clip };
    let base64: string;
    try {
      base64 = await this.capture({ ...rest, clip: prepared.clip });
    } finally {
      await this.view.evaluate("(__bwt_tester__.finishScreenshot(), 1)");
    }
    const buffer = Buffer.from(base64, "base64");
    if (options.save) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer);
    }
    return { buffer, path };
  }


  private async command(name: string, testPath: string | undefined, args: any[]) {
    const root = this.config.root;
    switch (name) {
      case "readFile": {
        const [path, options] = args;
        const encoding = typeof options === "string" ? options : options?.encoding || "utf-8";
        assertFileAccess(this.config, resolve(root, path));
        return readFile(resolve(root, path), { encoding });
      }
      case "writeFile": {
        const [path, data, options] = args;
        const filepath = resolve(root, path);
        assertFileAccess(this.config, filepath);
        await mkdir(dirname(filepath), { recursive: true });
        await writeFile(filepath, data, options);
        return;
      }
      case "removeFile":
        assertFileAccess(this.config, resolve(root, args[0]));
        await rm(resolve(root, args[0]));
        return;
      case "__vitest_screenshotMatcher": {
        const path = testPath ?? this.filepath;
        const context = {
          testPath: path,
          triggerCommand: (command: string, ...rest: any[]) => {
            if (command !== "__vitest_takeScreenshot") throw new Error(`Unsupported command ${command}`);
            return this.takeScreenshot(path, rest[0], rest[1]);
          },
          project: {
            config: {
              root: this.config.root,
              attachmentsDir: resolve(this.config.root, this.config.attachmentsDir),
              browser: { name: this.browserName, expect: { toMatchScreenshot: this.config.toMatchScreenshot } },
            },
            serializedConfig: { root: this.config.root, snapshotOptions: { updateSnapshot: this.config.updateSnapshot } },
          },
        };
        return screenshotMatcher(context, args[0], args[1], args[2]);
      }
      case "__vitest_fileInfo": {
        const info = (await this.rpc("fileInfo", [args[0]])) as { content: string; basename: string; mime: string };
        if (args[1] && args[1] !== "base64") {
          info.content = Buffer.from(info.content, "base64").toString(args[1]);
        }
        return info;
      }
    }
    const custom = this.config.commands[name];
    if (!custom) throw new Error(`Command "${name}" is not defined. Pass it to configureBrowserMode({ commands }).`);
    const session = this;
    return custom({
      testPath: testPath ?? this.filepath,
      get view() {
        // 任意の CDP 設定や初期化スクリプトなどを次のファイルに持ち越さない。
        session.reusable = false;
        return session.webView;
      },
    }, ...args);
  }

  // ---- bun test への登録 ----

  resultOf(id: string): TaskResult | undefined {
    return this.results.get(id);
  }

  /** テストが失敗していなくても、親のスイートのフック（beforeAll など）が失敗していればそのエラー。 */
  ancestorErrors(id: string): SerializedError[] {
    for (let p = this.parents.get(id); p; p = this.parents.get(p)) {
      const r = this.results.get(p);
      if (r?.state === "fail" && r.errors?.length) return r.errors;
    }
    return [];
  }
}

/**
 * Bun.WebView は cdp() と evaluate() をそれぞれ同時に 1 つしか受け付けないので、順番待ちにする。
 * （toMatchScreenshot は撮影を並行して頼むし、CDP のイベント転送とページからの呼び出しも重なる）
 */
function serializeViewCalls(view: WebView) {
  for (const key of ["cdp", "evaluate"] as const) {
    const original = (view[key] as Function).bind(view);
    let tail: Promise<unknown> = Promise.resolve();
    (view as any)[key] = (...args: unknown[]) => {
      const run = tail.then(() => original(...args));
      tail = run.catch(() => {});
      return run;
    };
  }
}

const chromePath = detectChromePath;

function testNamePattern(): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-t" || a === "--test-name-pattern") return argv[i + 1];
    if (a.startsWith("--test-name-pattern=")) return a.slice("--test-name-pattern=".length);
  }
  return undefined;
}

const LONG = 2 ** 31 - 1;

function registerTasks(session: FileSession, tasks: SerializedTask[]) {
  for (const task of tasks) {
    if (task.type === "suite") {
      describe(task.name, () => {
        registerTasks(session, task.tasks ?? []);
        // Vitest は todo だけの suite も skip にする。子の mode を保ち、
        // 実行されない suite に Bun のフック由来の (unnamed) を追加しない。
        if (task.mode === "skip" || task.mode === "todo") return;
        afterAll(async () => {
          const r = session.resultOf(task.id);
          // テストに紐付かないスイートのエラー（afterAll の失敗など）はここで報告する
          const testsFailed = (task.tasks ?? []).some(
            (t) => session.resultOf(t.id)?.state === "skip" && session.ancestorErrors(t.id).length,
          );
          if (r?.state === "fail" && r.errors?.length && !testsFailed) throw combine(r.errors);
        }, LONG);
      });
      continue;
    }
    if (task.mode === "todo") {
      test.todo(task.name, () => {});
      continue;
    }
    if (task.mode === "skip") {
      test.skip(task.name, () => {});
      continue;
    }
    const r = session.resultOf(task.id) ?? { state: "skip" };
    const inherited = r.state === "skip" ? session.ancestorErrors(task.id) : [];
    if (r.state === "skip" && !inherited.length) {
      test.skip(task.name, () => {});
      continue;
    }
    test(
      task.name,
      async () => {
        if (r.state === "fail") {
          const err = combine(r.errors?.length ? r.errors : [{ message: "Test failed" }]);
          const shots = [...new Set(session.failureScreenshots.get(task.id) ?? [])];
          if (shots.length) {
            // vitest の printError と同じ書式
            err.message += `\n\nFailure screenshot${shots.length > 1 ? "s" : ""}:\n${shots.map((p) => `  - ${relative(process.cwd(), p)}`).join("\n")}`;
            err.stack = `${err.name}: ${err.message}`;
          }
          throw err;
        }
        // beforeAll の失敗で skip になった場合は、成功や skip にせずエラーを報告する。
        if (inherited.length) throw combine(inherited);
      },
      LONG,
    );
  }
}

/** テストファイルの代わりに読み込まれるスタブから呼ばれる。 */
export async function runBrowserTestFile(filepath: string): Promise<void> {
  const session = new FileSession(filepath);
  let fileTasks: SerializedTask[];
  try {
    await session.start();
    fileTasks = await Promise.race([
      session.collected.promise,
      session.finished.promise.then(() => {
        throw combine(session.unhandled.length ? session.unhandled : [{ message: "The page finished without collecting tests" }]);
      }),
    ]);
  } catch (err) {
    await session.close();
    test(basename(filepath), () => {
      throw err;
    });
    return;
  }
  // bun:test には実行中のテストを skip に変える公開 API がないため、
  // ブラウザ側のフックまで完了してから最終結果に合わせて登録する。
  await session.finished.promise;
  const file = fileTasks[0]!;
  if (file.result?.state === "fail" && file.result.errors?.length) {
    const errors = file.result.errors;
    test(basename(filepath), () => {
      throw combine(errors);
    });
  }
  registerTasks(session, file.tasks ?? []);
  afterAll(async () => {
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Receipt of onFinished precedes the browser consuming its response.
      // Keep the page alive until the client and its error reporting settle.
      await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out after 30000ms waiting for browser completion")), 30_000);
        }),
        session.view.evaluate("__bwt_tester__.finished.then(() => true)"),
      ]);
      completed = true;
    } finally {
      clearTimeout(timer);
      // A timed-out evaluate may still occupy the queue. Do not navigate or
      // enqueue another evaluate to reset this page; close it directly.
      await session.close(completed);
    }
    if (session.unhandled.length) {
      const err = combine(session.unhandled);
      err.message = `Unhandled error(s) in the browser:\n${err.message}`;
      throw err;
    }
  }, LONG);
}

export { ANSI };
