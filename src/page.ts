import { Queryable } from "./locator";
import type { PageError, Step } from "./protocol";
import type { Bundle } from "./server";
import { getSession } from "./session";

type AnyFn = (...args: any[]) => any;
type FnKeys<M> = { [K in keyof M]: M[K] extends AnyFn ? K : never }[keyof M] & string;
type Args<F> = F extends (...args: infer A) => any ? A : never;
type Ret<F> = F extends (...args: any[]) => infer R ? Awaited<R> : never;

/**
 * ページに読み込んだ ES モジュールへのハンドル。
 * `importModule<typeof import("./x")>(...)` と型を渡すと call の引数と戻り値に型が付く。
 * 引数と戻り値は JSON でやり取りされる。
 */
export class ModuleHandle<M = Record<string, AnyFn>> {
  constructor(private readonly bundle: Bundle) {}

  get url(): string {
    return this.bundle.url;
  }

  async call<K extends FnKeys<M>>(name: K, ...args: Args<M[K]>): Promise<Ret<M[K]>> {
    const s = await getSession();
    return s.invoke("call", [this.bundle.url, this.bundle.css, name, args]);
  }
}

export interface ScreenshotOptions {
  /** 指定するとファイルにも書き出す。 */
  path?: string;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
}

class Page extends Queryable {
  protected readonly steps: Step[] = [];
  protected readonly label = "page";

  /** 生の Bun.WebView。足りない操作はこれで直接どうぞ。 */
  async view() {
    return (await getSession()).view;
  }

  /** 相対パスはテスト用サーバー（publicDir を配信）からの URL として解決する。 */
  async goto(url: string): Promise<void> {
    const s = await getSession();
    const target = new URL(url, `${s.server.origin}/`).href;
    await s.run((v) => v.navigate(target));
  }

  /**
   * HTML をページに表示する。断片なら <div id="root"> の中に入れ、
   * <html> を含む完全な文書ならそのまま表示する（どちらも <script> は実行される）。
   */
  async setContent(html: string): Promise<void> {
    const s = await getSession();
    const url = s.server.putContent(html);
    try {
      await s.run((v) => v.navigate(url));
    } finally {
      s.server.dropContent(url);
    }
  }

  /**
   * entry を Bun.build でブラウザ向けにバンドルしてページで読み込み、
   * `export default (root: HTMLElement, props) => void | (() => void)` を呼ぶ。
   * CSS の import も <link> として読み込まれる。
   */
  async mount<P = unknown>(entry: string | URL, props?: P): Promise<void> {
    const s = await getSession();
    const b = await s.server.bundle(entry);
    await s.invoke("mount", [b.url, b.css, props ?? null]);
  }

  async importModule<M = Record<string, AnyFn>>(entry: string | URL): Promise<ModuleHandle<M>> {
    const s = await getSession();
    return new ModuleHandle<M>(await s.server.bundle(entry));
  }

  /**
   * ページ内で関数を実行する。関数は文字列化して送られるので、外側の変数は参照できない。
   * 必要な値は args で渡す（JSON で送られる）。
   */
  async evaluate<R, A extends unknown[]>(fn: string | ((...args: A) => R), ...args: A): Promise<Awaited<R>> {
    const s = await getSession();
    const script = typeof fn === "string" ? fn : `(${fn.toString()})(...${JSON.stringify(args)})`;
    return s.run((v) => v.evaluate(script)) as Promise<Awaited<R>>;
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const s = await getSession();
    const buf = await s.run((v) =>
      v.screenshot({ encoding: "buffer", format: options.format, quality: options.quality }),
    );
    if (options.path) await Bun.write(options.path, buf);
    return buf;
  }

  async setViewport(width: number, height: number): Promise<void> {
    const s = await getSession();
    await s.run((v) => v.resize(width, height));
  }

  async url(): Promise<string> {
    return (await getSession()).view.url;
  }

  async title(): Promise<string> {
    return this.evaluate("document.title") as Promise<string>;
  }

  async reload(): Promise<void> {
    const s = await getSession();
    await s.run((v) => v.reload());
  }

  /** ページ内で捕まらなかった例外を取り出す（取り出したものは消える）。 */
  async takeErrors(): Promise<PageError[]> {
    return (await getSession()).invoke<PageError[]>("errors");
  }
}

export type { Page };
export const page = new Page();
