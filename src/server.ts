import { stat } from "node:fs/promises";
import { basename, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_ENTRY = join(import.meta.dir, "runtime", "client.ts");
const RUNTIME_TAG = `<script src="/__bwt/runtime.js"></script>`;

export const HARNESS_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bun-webview-test</title>
${RUNTIME_TAG}
</head>
<body><div id="root"></div></body>
</html>`;

export interface Bundle {
  url: string;
  css: string[];
}

interface Asset {
  body: ArrayBuffer | string;
  type: string;
}

/** ページ側ランタイムを IIFE 1 本にまとめる。 */
async function buildRuntime(): Promise<string> {
  const result = await Bun.build({ entrypoints: [RUNTIME_ENTRY], target: "browser", format: "iife" });
  if (!result.success) throw new AggregateError(result.logs, "failed to build page runtime");
  return result.outputs[0]!.text();
}

function injectRuntime(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${RUNTIME_TAG}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${RUNTIME_TAG}</head>`);
  return `${RUNTIME_TAG}${html}`;
}

export function toFilePath(entry: string | URL): string {
  if (entry instanceof URL) return fileURLToPath(entry);
  if (entry.startsWith("file://")) return fileURLToPath(entry);
  return resolvePath(entry);
}

/** テスト用ページとバンドル結果を配信するローカルサーバー。 */
export class AssetServer {
  readonly runtimeSource: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly assets = new Map<string, Asset>();
  private readonly bundles = new Map<string, Promise<Bundle>>();
  private seq = 0;

  private constructor(runtimeSource: string, publicDir: string | undefined) {
    this.runtimeSource = runtimeSource;
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handle(req, publicDir),
    });
  }

  static async start(publicDir?: string): Promise<AssetServer> {
    return new AssetServer(await buildRuntime(), publicDir);
  }

  get origin(): string {
    return this.server.url.origin;
  }

  stop() {
    this.server.stop(true);
  }

  /** setContent 用に HTML を一時的に置き、その URL を返す。 */
  putContent(html: string): string {
    const full = /<html|<!doctype/i.test(html)
      ? injectRuntime(html)
      : HARNESS_HTML.replace(`<div id="root"></div>`, `<div id="root">${html}</div>`);
    const path = `/__bwt/content/${++this.seq}.html`;
    this.assets.set(path, { body: full, type: "text/html;charset=utf-8" });
    return `${this.origin}${path}`;
  }

  dropContent(url: string) {
    this.assets.delete(new URL(url).pathname);
  }

  /** エントリを Bun.build でブラウザ向けにバンドルし、配信 URL を返す。mtime が変わるまでキャッシュする。 */
  async bundle(entry: string | URL): Promise<Bundle> {
    const file = toFilePath(entry);
    const { mtimeMs } = await stat(file);
    const key = `${file}:${mtimeMs}`;
    let p = this.bundles.get(key);
    if (!p) {
      p = this.build(file, key);
      this.bundles.set(key, p);
      p.catch(() => this.bundles.delete(key));
    }
    return p;
  }

  private async build(file: string, key: string): Promise<Bundle> {
    const prefix = `/__bwt/b/${Bun.hash(key).toString(36)}/`;
    const result = await Bun.build({
      entrypoints: [file],
      target: "browser",
      format: "esm",
      sourcemap: "inline",
      publicPath: prefix,
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
    });
    if (!result.success) throw new AggregateError(result.logs, `failed to bundle ${file}`);
    let url = "";
    const css: string[] = [];
    for (const out of result.outputs) {
      const path = prefix + basename(out.path);
      this.assets.set(path, { body: await out.arrayBuffer(), type: out.type });
      if (out.kind === "entry-point") url = this.origin + path;
      else if (path.endsWith(".css")) css.push(this.origin + path);
    }
    return { url, css };
  }

  private async handle(req: Request, publicDir: string | undefined): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/__bwt/harness.html") {
      return new Response(HARNESS_HTML, { headers: { "content-type": "text/html;charset=utf-8" } });
    }
    if (pathname === "/__bwt/runtime.js") {
      return new Response(this.runtimeSource, { headers: { "content-type": "text/javascript" } });
    }
    const asset = this.assets.get(pathname);
    if (asset) return new Response(asset.body, { headers: { "content-type": asset.type } });

    if (publicDir) {
      const root = resolvePath(publicDir);
      const path = normalize(join(root, decodeURIComponent(pathname)));
      if (path.startsWith(root)) {
        const file = Bun.file(path);
        if (await file.exists()) {
          if (path.endsWith(".html")) {
            return new Response(injectRuntime(await file.text()), {
              headers: { "content-type": "text/html;charset=utf-8" },
            });
          }
          return new Response(file);
        }
      }
    }
    return new Response("not found", { status: 404 });
  }
}
