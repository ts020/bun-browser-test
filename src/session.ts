import { chromeBackend } from "./chrome";
import { getConfig, type BrowserConfig } from "./config";
import { AssetServer } from "./server";

type WebView = InstanceType<typeof Bun.WebView>;

/**
 * Bun.WebView 1 枚とアセットサーバーを束ねたもの。
 * WebView は evaluate を同時に 1 本しか受け付けないので、操作はすべて直列化する。
 */
export class BrowserSession {
  readonly view: WebView;
  readonly server: AssetServer;
  readonly config: BrowserConfig;
  /** 前回リセットしてから何か操作したか。 */
  dirty = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(view: WebView, server: AssetServer, config: BrowserConfig) {
    this.view = view;
    this.server = server;
    this.config = config;
  }

  static async start(config = getConfig()): Promise<BrowserSession> {
    const backend =
      config.backend === "webkit"
        ? ("webkit" as const)
        : await chromeBackend(config.chromePath, config.chromeArgs);
    const server = await AssetServer.start(config.publicDir);
    const view = new Bun.WebView({
      backend,
      width: config.width,
      height: config.height,
      console: config.forwardConsole ? globalThis.console : undefined,
    });
    const session = new BrowserSession(view, server, config);
    await session.run((v) => v.navigate(`${server.origin}/`));
    return session;
  }

  /** WebView への操作を直列に実行する。 */
  run<T>(fn: (view: WebView) => Promise<T>): Promise<T> {
    this.dirty = true;
    const next = this.queue.then(() => fn(this.view));
    this.queue = next.catch(() => {});
    return next;
  }

  /** ページ側ランタイム (window.__bwt) の関数を呼ぶ。外部ページなどで未注入なら注入してから呼ぶ。 */
  async invoke<T>(name: string, args: unknown[] = []): Promise<T> {
    const call = `(window.__bwt ? window.__bwt.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)}).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e && e.message || e), s: e && e.stack })) : { missing: true })`;
    type Res = { ok: true; v: T } | { ok: false; e: string; s?: string } | { missing: true };
    let res = await this.run((v) => v.evaluate<Res>(call));
    if ("missing" in res) {
      await this.run((v) => v.evaluate(`(0, eval)(${JSON.stringify(this.server.runtimeSource)}), 1`));
      res = await this.run((v) => v.evaluate<Res>(call));
      if ("missing" in res) throw new Error("bun-webview-test: failed to inject the page runtime");
    }
    if (!res.ok) {
      const err = new Error(res.e);
      if (res.s) err.stack = `${res.e}\n    (in page)\n${res.s}`;
      throw err;
    }
    return res.v;
  }

  async reset(): Promise<void> {
    await this.run((v) => v.navigate(`${this.server.origin}/`));
    this.dirty = false;
  }

  close() {
    this.view.close();
    this.server.stop();
  }
}

let session: Promise<BrowserSession> | null = null;

export function getSession(): Promise<BrowserSession> {
  if (!session) {
    session = BrowserSession.start();
    session.catch(() => (session = null));
  }
  return session;
}

/** 起動済みならそのセッションを返す。未起動なら null（起動はしない）。 */
export async function peekSession(): Promise<BrowserSession | null> {
  return session ? session.catch(() => null) : null;
}

export async function closeSession(): Promise<void> {
  const s = await peekSession();
  session = null;
  s?.close();
}
