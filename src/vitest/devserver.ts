// Vite の開発サーバーの代わり。テストファイルやそこから import されるソースを 1 ファイルずつ変換して配信する。
// バンドルしないので、vitest（Vite）と同じく本物の ES モジュールとして動く。
// - セットアップファイルとテストファイルが同じモジュールを import すれば同じインスタンスになる
// - `import * as ns` の名前空間は書き換えられない（vi.spyOn がエラーになる）
// - import.meta.url は配信している URL になる
// node_modules のパッケージは Vite の依存関係の事前バンドル（optimizeDeps）と同じく、まとめて Bun.build する。

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { init as initLexer, parse as parseImports } from "es-module-lexer";
import { SHARED_MODULES } from "./bundler";
import type { BrowserModeConfig } from "./config";

export interface Output {
  body: ArrayBuffer | string;
  type: string;
}

const SCRIPT_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const ASSET_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif", ".bmp",
  ".mp4", ".webm", ".ogg", ".mp3", ".wav", ".flac", ".aac", ".opus",
  ".woff", ".woff2", ".eot", ".ttf", ".otf",
  ".webmanifest", ".pdf", ".txt",
]);

const isScript = (file: string) => SCRIPT_EXTS.has(extname(file));
const isCss = (file: string) => /\.(css|scss|sass|less|styl|stylus|pcss|postcss)$/.test(file);

// Bun が `import * as ns` 用に作る名前空間オブジェクトは書き換えられてしまうが、本物の ES モジュールの名前空間は
// 書き換えられない（vi.spyOn(ns, "fn") がエラーになる）。vitest（Vite）と同じ挙動にするため、ヘルパーを差し替える。
const EXPORT_HELPER = /configurable: true,\s*set: __exportSetter\.bind\(all, name\)\s*\}\);\s*\};/;
const ESM_EXPORT_HELPER = `configurable: false
    });
  __defProp(target, Symbol.toStringTag, { value: "Module" });
};`;

export function patchNamespaceHelper(code: string): string {
  // ソースマップの行がずれないよう、改行の数をそろえる
  return code.replace(EXPORT_HELPER, (m) => {
    const lines = m.split("\n").length - ESM_EXPORT_HELPER.split("\n").length;
    return ESM_EXPORT_HELPER.replace(/\};$/, `};${"\n".repeat(Math.max(lines, 0))}`);
  });
}

function splitQuery(id: string): [string, string] {
  const i = id.indexOf("?");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i)];
}

function hasQuery(query: string, name: string) {
  return new URLSearchParams(query.slice(1)).has(name);
}

type Resolved =
  | { type: "shared"; id: string }
  | { type: "url"; id: string }
  | { type: "file"; file: string; query: string }
  | { type: "dep"; spec: string };

interface Transformed {
  code: string;
  map: any;
  mtime: number;
}

interface DepEntry {
  url: string;
  cjs: boolean;
}

export class DevServer {
  private transformCache = new Map<string, Transformed>();
  private deps = new Map<string, DepEntry>();
  private depFiles = new Map<string, Output>();
  private depMaps = new Map<string, any>();
  depCss: string[] = [];
  private depsVersion = 0;
  private depsBuild: Promise<void> = Promise.resolve();
  private readonly cacheDir: string;

  constructor(readonly config: BrowserModeConfig) {
    this.cacheDir = join(config.root, "node_modules", ".bwt");
  }

  // ---- URL とファイルの対応（Vite と同じく root の中は /path、外は /@fs/abs） ----

  fileUrl(file: string, query = ""): string {
    const rel = relative(this.config.root, file);
    const url = !rel.startsWith("..") && !isAbsolute(rel) ? `/${rel.split("\\").join("/")}` : `/@fs${file.startsWith("/") ? "" : "/"}${file}`;
    return url + query;
  }

  urlToFile(pathname: string): string {
    const decoded = decodeURIComponent(pathname);
    if (decoded.startsWith("/@fs/")) return decoded.slice(4);
    return join(this.config.root, decoded);
  }

  // ---- 解決 ----

  resolve(spec: string, importer: string): Resolved {
    if (spec in SHARED_MODULES) return { type: "shared", id: spec };
    if (/^(https?:|data:|blob:)/.test(spec) || spec.startsWith("//")) return { type: "url", id: spec };
    const [path, query] = splitQuery(spec);
    let target = path;
    let aliased = false;
    for (const [from, to] of Object.entries(this.config.alias).sort((a, b) => b[0].length - a[0].length)) {
      if (target === from || target.startsWith(`${from}/`)) {
        const replaced = to + target.slice(from.length);
        target = replaced.startsWith(".") ? resolve(this.config.root, replaced) : replaced;
        aliased = true;
        break;
      }
    }
    const dir = dirname(importer);
    if (this.config.optimizeDeps.include?.includes(path)) {
      return { type: "dep", spec: aliased && target.startsWith(".") ? resolve(this.config.root, target) : target };
    }
    if (target.startsWith("/@fs/")) target = target.slice(4);
    else if (target.startsWith("/") && !aliased && !this.resolveFile(target, dir)) {
      // Vite と同じく、/ から始まるパスはまず root からのパスとして探す
      target = join(this.config.root, target);
    }
    if (target.startsWith(".") || isAbsolute(target)) {
      const file = this.resolveFile(resolve(dir, target), dir);
      if (!file) throw new Error(`Failed to resolve import "${spec}" from "${importer}". Does the file exist?`);
      if (file.includes("/node_modules/")) return { type: "dep", spec: file };
      return { type: "file", file, query };
    }
    // エイリアスの行き先がパッケージ名のこともある
    spec = target;
    return { type: "dep", spec };
  }

  private resolveFile(abs: string, dir: string): string | null {
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
    try {
      return Bun.resolveSync(abs, dir);
    } catch {
      return null;
    }
  }

  // ---- 変換 ----

  private async transformScript(file: string): Promise<Transformed> {
    const mtime = statSync(file).mtimeMs;
    const cached = this.transformCache.get(file);
    if (cached && cached.mtime === mtime) return cached;
    const define: Record<string, string> = {
      "process.env.NODE_ENV": JSON.stringify("test"),
      ...this.config.define,
      // Vite（vitest）と同じく、import.meta.env はどのモジュールからも同じオブジェクトを指す
      "import.meta.env": "globalThis.__vitest_worker__.metaEnv",
    };
    const externalAll: BunPlugin = {
      name: "bwt-external",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point-build" || args.kind === "entry-point-run") return undefined;
          return { path: args.path, external: true };
        });
      },
    };
    const result = await Bun.build({
      entrypoints: [file],
      target: "browser",
      format: "esm",
      sourcemap: "external",
      define,
      plugins: [externalAll],
      throw: false,
    });
    if (!result.success) {
      const error = new Error(`Failed to transform ${file}\n${result.logs.map((l) => `  ${String(l)}`).join("\n")}`);
      throw error;
    }
    let code = "";
    let map: any = null;
    for (const out of result.outputs) {
      if (out.kind === "entry-point") code = await out.text();
      else if (out.kind === "sourcemap") map = JSON.parse(await out.text());
    }
    // Bun の出力の末尾の debugId コメントを取り除く（ソースマップは別に配る）
    code = code.replace(/\n\/\/# debugId=[0-9A-F]+\s*$/, "\n");
    // 1 ファイルずつ変換しているので、ソースはそのファイルだけ（Bun は cwd からの相対パスで書く）
    if (map?.sources) map.sources = map.sources.length === 1 ? [file] : map.sources.map((s: string) => resolve(s));
    const transformed = { code, map, mtime };
    this.transformCache.set(file, transformed);
    return transformed;
  }

  /** モジュールの依存（静的 import と、文字列の動的 import）を集める。 */
  private async scan(file: string): Promise<{ files: string[]; deps: string[] }> {
    await initLexer;
    const { code } = await this.transformScript(file);
    const [imports] = parseImports(code);
    const files: string[] = [];
    const deps: string[] = [];
    for (const imp of imports) {
      if (imp.d === -2 || imp.n === undefined) continue;
      const r = this.resolve(imp.n, file);
      if (r.type === "file" && isScript(r.file)) files.push(r.file);
      else if (r.type === "dep") deps.push(r.spec);
    }
    return { files, deps };
  }

  /**
   * テストを始める前に、入口から辿れるモジュールを変換して node_modules の依存を集め、まとめてバンドルしておく。
   * （途中で依存が増えてバンドルし直すと、同じパッケージが 2 つ読み込まれてしまうため）
   */
  async prepare(entries: string[]): Promise<void> {
    const seen = new Set<string>();
    const deps = new Set<string>();
    // パッケージ名の入口（setupFiles: ["vitest-browser-react"] など）はそのまま依存として扱う
    for (const e of entries) if (!isAbsolute(e)) deps.add(e);
    const queue = entries.filter((e) => isAbsolute(e) && isScript(e));
    while (queue.length) {
      const batch = queue.splice(0).filter((f) => !seen.has(f));
      for (const f of batch) seen.add(f);
      const results = await Promise.all(batch.map((f) => this.scan(f).catch(() => ({ files: [], deps: [] }))));
      for (const r of results) {
        for (const f of r.files) if (!seen.has(f)) queue.push(f);
        for (const d of r.deps) deps.add(d);
      }
    }
    await this.ensureDeps([...deps]);
  }

  private ensureDeps(specs: string[]): Promise<void> {
    this.depsBuild = this.depsBuild.then(() => {
      const missing = specs.filter((s) => !this.deps.has(s));
      if (!missing.length) return;
      return this.buildDeps([...new Set([...this.deps.keys(), ...missing])]);
    });
    return this.depsBuild;
  }

  private async buildDeps(specs: string[]): Promise<void> {
    const version = ++this.depsVersion;
    const hash = createHash("sha1").update(specs.join("\n")).digest("hex").slice(0, 8);
    const entryDir = join(this.cacheDir, `deps-${hash}`);
    mkdirSync(entryDir, { recursive: true });
    const entries = specs.map((spec, i) => {
      const file = join(entryDir, `d${i}.js`);
      const s = JSON.stringify(spec);
      // ES モジュールなら名前付きの export も残す（export * from）。default にはパッケージの名前空間を入れる
      writeFileSync(file, `export * from ${s};\nimport * as __ns from ${s};\nexport default __ns;\n`);
      return file;
    });
    const result = await Bun.build({
      entrypoints: entries,
      target: "browser",
      format: "esm",
      splitting: true,
      external: Object.keys(SHARED_MODULES),
      naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
      define: { "process.env.NODE_ENV": JSON.stringify("test"), ...this.config.define },
      metafile: true,
      sourcemap: "external",
      throw: false,
      outdir: join(entryDir, "out"),
    } as Parameters<typeof Bun.build>[0]);
    if (!result.success) {
      throw new Error(`Failed to bundle dependencies (${specs.join(", ")})\n${result.logs.map((l) => `  ${String(l)}`).join("\n")}`);
    }
    const metafile = (result as any).metafile as { inputs: Record<string, { imports: { path: string; original?: string }[]; format?: string }> };
    const formatOf = new Map<string, string | undefined>();
    for (const [input, info] of Object.entries(metafile?.inputs ?? {})) {
      if (!input.includes(`deps-${hash}`)) continue;
      const i = Number(/d(\d+)\.js$/.exec(input)?.[1]);
      const target = info.imports[0]?.path;
      if (Number.isNaN(i) || !target) continue;
      const targetInfo = metafile.inputs[relative(process.cwd(), target)] ?? metafile.inputs[target];
      formatOf.set(specs[i]!, targetInfo?.format);
    }
    const prefix = `/@bwt-deps/v${version}/`;
    const outdir = join(entryDir, "out");
    const css: string[] = [];
    for (const out of result.outputs) {
      const rel = relative(outdir, out.path).split("\\").join("/");
      if (out.kind === "sourcemap") {
        const map = JSON.parse(await out.text());
        const dir = dirname(out.path);
        map.sources = (map.sources as string[]).map((src) => resolve(dir, src));
        this.depMaps.set(prefix + rel.replace(/\.map$/, ""), map);
        continue;
      }
      let body: ArrayBuffer | string = await out.arrayBuffer();
      if (rel.endsWith(".js")) body = patchNamespaceHelper(new TextDecoder().decode(body));
      this.depFiles.set(prefix + rel, { body, type: out.type });
      if (rel.endsWith(".css")) css.push(prefix + rel);
    }
    this.depCss = css;
    specs.forEach((spec, i) => {
      this.deps.set(spec, { url: `${prefix}d${i}.js`, cjs: formatOf.get(spec) === "cjs" });
    });
  }

  // ---- import の書き換え ----

  private async rewrite(file: string, code: string): Promise<string> {
    await initLexer;
    const [imports] = parseImports(code);
    const missing: string[] = [];
    for (const imp of imports) {
      if (imp.n === undefined || imp.d === -2) continue;
      const r = this.resolve(imp.n, file);
      if (r.type === "dep" && !this.deps.has(r.spec)) missing.push(r.spec);
    }
    if (missing.length) await this.ensureDeps(missing);

    let out = "";
    let last = 0;
    let n = 0;
    for (const imp of imports) {
      if (imp.d === -2) continue;
      // 文字列でない動的 import は実行時に解決する
      if (imp.n === undefined) {
        if (imp.d > -1) {
          out += code.slice(last, imp.ss);
          out += `__vitest_browser_runner__.wrapDynamicImport(() => __bwt_import__(${code.slice(imp.s, imp.e)}, import.meta.url))`;
          last = imp.se;
        }
        continue;
      }
      const r = this.resolve(imp.n, file);
      if (r.type === "shared" || r.type === "url") continue;
      if (r.type === "file") {
        const url = this.fileUrl(r.file, isScript(r.file) && !r.query ? r.query : r.query || "?import");
        if (imp.d > -1) {
          // vitest と同じく、動的 import は vi.dynamicImportSettled() で待てるように包む
          out += code.slice(last, imp.ss);
          out += `__vitest_browser_runner__.wrapDynamicImport(() => import(${JSON.stringify(url)}))`;
          last = imp.se;
          continue;
        }
        // 静的 import は引用符の中だけを置き換える
        out += code.slice(last, imp.s);
        out += url;
        last = imp.e;
        continue;
      }
      const dep = this.deps.get(r.spec)!;
      const local = `__bwt_dep_${n++}`;
      if (imp.d > -1) {
        out += code.slice(last, imp.ss);
        out += `__vitest_browser_runner__.wrapDynamicImport(() => import(${JSON.stringify(dep.url)}).then((m) => ${dep.cjs ? `__bwt_cjs_ns__(m.default)` : "m.default"}))`;
        last = imp.se;
        continue;
      }
      out += code.slice(last, imp.ss);
      out += this.rewriteDepStatement(code.slice(imp.ss, imp.se), dep, local);
      last = imp.se;
    }
    out += code.slice(last);
    return out;
  }

  /** node_modules のパッケージの import / export 文を、事前バンドルしたモジュールを使う形に書き換える。 */
  private rewriteDepStatement(statement: string, dep: DepEntry, local: string): string {
    const url = JSON.stringify(dep.url);
    const m = /^(import|export)\s*([\s\S]*?)\s*from\s*["'][^"']*["']\s*;?$/.exec(statement);
    if (!m) {
      // import "pkg"（副作用だけ）
      return `import ${url}`;
    }
    const [, keyword, clauseRaw] = m;
    const clause = clauseRaw!.trim();
    const lines: string[] = [`import ${local} from ${url};`];
    const ns = dep.cjs ? `__bwt_cjs_ns__(${local})` : local;
    if (keyword === "export") {
      if (clause === "*") return `export * from ${url}`;
      const star = /^\*\s+as\s+(.+)$/.exec(clause);
      if (star) {
        lines.push(`const ${local}_ns = ${ns};`, `export { ${local}_ns as ${star[1]} };`);
        return lines.join(" ");
      }
      const names = parseNamed(clause);
      const decls = names.map(([imported], i) => `${local}_${i} = ${ns}[${JSON.stringify(imported)}]`);
      if (decls.length) lines.push(`const ${decls.join(", ")};`);
      lines.push(`export { ${names.map(([, exported], i) => `${local}_${i} as ${exported}`).join(", ")} };`);
      return lines.join(" ");
    }
    const decls: string[] = [];
    let rest = clause;
    const def = /^([\w$]+)\s*(,|$)/.exec(rest);
    if (def) {
      decls.push(`${def[1]} = ${ns}.default`);
      rest = rest.slice(def[0].length).trim();
    }
    const star = /^\*\s+as\s+([\w$]+)$/.exec(rest);
    if (star) decls.push(`${star[1]} = ${ns}`);
    else if (rest.startsWith("{")) {
      for (const [imported, as] of parseNamed(rest)) decls.push(`${as} = ${ns}[${JSON.stringify(imported)}]`);
    }
    if (decls.length) lines.push(`const ${decls.join(", ")};`);
    return lines.join(" ");
  }

  // ---- 配信 ----

  async load(pathname: string, search: string): Promise<Response | null> {
    if (pathname.startsWith("/@bwt-deps/")) {
      await this.depsBuild;
      if (hasQuery(search, "bwt-map")) return Response.json(this.depMaps.get(pathname) ?? {});
      const out = this.depFiles.get(pathname);
      return out ? new Response(out.body, { headers: { "content-type": out.type } }) : null;
    }
    const file = this.urlToFile(pathname);
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const query = search;
    const js = (code: string) =>
      new Response(code, { headers: { "content-type": "text/javascript;charset=utf-8", "cache-control": "no-store" } });

    if (hasQuery(query, "bwt-map")) {
      const t = this.transformCache.get(file);
      return t?.map ? Response.json(t.map) : new Response("{}", { headers: { "content-type": "application/json" } });
    }
    if (hasQuery(query, "raw")) return js(`export default ${JSON.stringify(await Bun.file(file).text())};`);
    if (hasQuery(query, "url")) return js(`export default ${JSON.stringify(this.fileUrl(file))};`);
    if (isScript(file) && !file.includes("/node_modules/")) {
      const { code } = await this.transformScript(file);
      const rewritten = await this.rewrite(file, code);
      return js(`${rewritten}\n//# sourceMappingURL=${this.fileUrl(file, "?bwt-map")}`);
    }
    if (!hasQuery(query, "import")) return null;
    if (isCss(file)) return js(await this.cssModule(file, hasQuery(query, "inline")));
    if (extname(file) === ".json") {
      const data = JSON.parse(await Bun.file(file).text());
      const names =
        data && typeof data === "object" && !Array.isArray(data)
          ? Object.keys(data).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k))
          : [];
      return js(
        `const data = ${JSON.stringify(data)};\nexport default data;\n${names.map((k) => `export const ${k} = data.${k};`).join("\n")}`,
      );
    }
    if (ASSET_EXTS.has(extname(file)) || !isScript(file)) return js(`export default ${JSON.stringify(this.fileUrl(file))};`);
    return null;
  }

  private async cssModule(file: string, inline: boolean): Promise<string> {
    const isModule = /\.module\.\w+$/.test(file);
    let css = await Bun.file(file).text();
    let classes: Record<string, string> | null = null;
    if (isModule || css.includes("@import") || css.includes("url(")) {
      // Bun.build で @import をまとめ、url() を配信できる場所に向け、CSS Modules のクラス名を付ける
      const result = await Bun.build({ entrypoints: [file], target: "browser", throw: false, publicPath: `${this.fileUrl(dirname(file))}/` } as Parameters<typeof Bun.build>[0]);
      if (result.success) {
        for (const out of result.outputs) {
          if (out.path.endsWith(".css")) css = await out.text();
          else if (isModule && out.kind === "entry-point" && out.path.endsWith(".js")) {
            classes = extractCssModuleClasses(await out.text());
          }
        }
      }
    }
    if (inline) return `export default ${JSON.stringify(css)};`;
    const id = JSON.stringify(file);
    return `const id = ${id};
const css = ${JSON.stringify(css)};
let style = document.querySelector(\`style[data-vite-dev-id="\${CSS.escape(id)}"]\`);
if (!style) {
  style = document.createElement("style");
  style.setAttribute("type", "text/css");
  style.setAttribute("data-vite-dev-id", id);
  document.head.appendChild(style);
}
style.textContent = css;
export default ${classes ? JSON.stringify(classes) : "css"};
${classes ? Object.keys(classes).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k)).map((k) => `export const ${k} = ${JSON.stringify(classes![k])};`).join("\n") : ""}`;
  }

  /** prepare() で事前バンドルしたパッケージの URL（setupFiles にパッケージ名を書いたとき）。 */
  depUrl(spec: string): string {
    const dep = this.deps.get(spec);
    if (!dep) throw new Error(`Package "${spec}" was not prepared`);
    return dep.url;
  }

  /** 文字列でない import(...) を実行時に解決する。 */
  async resolveDynamic(spec: string, importerUrl: string): Promise<{ url: string; dep?: boolean; cjs?: boolean } | { error: string }> {
    try {
      const importer = this.urlToFile(new URL(importerUrl).pathname);
      const r = this.resolve(spec, importer);
      if (r.type === "shared" || r.type === "url") return { url: r.id };
      if (r.type === "file") return { url: this.fileUrl(r.file, isScript(r.file) ? r.query : r.query || "?import") };
      await this.ensureDeps([r.spec]);
      const dep = this.deps.get(r.spec)!;
      return { url: dep.url, dep: true, cjs: dep.cjs };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  }

  getSourceMap(pathname: string): any {
    return this.transformCache.get(this.urlToFile(pathname))?.map ?? null;
  }
}

function extractCssModuleClasses(js: string): Record<string, string> | null {
  // Bun.build が CSS Modules から作る JS は { name: "name_hash" } のオブジェクトを default export する
  const m = /\{([\s\S]*?)\}/.exec(js.slice(js.indexOf("var ")));
  if (!m) return null;
  const classes: Record<string, string> = {};
  for (const pair of m[1]!.matchAll(/["']?([\w-]+)["']?\s*:\s*["']([^"']+)["']/g)) classes[pair[1]!] = pair[2]!;
  return classes;
}

const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(
    " ",
  ),
);

/** `{ a, b as c, default as d, "x-y" as e }` を [元の名前, 新しい名前][] にする。 */
function parseNamed(clause: string): [string, string][] {
  const body = clause.replace(/^\{|\}$/g, "").trim();
  if (!body) return [];
  return body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = /^(["'][^"']*["']|[\w$]+)(?:\s+as\s+(["'][^"']*["']|[\w$]+))?$/.exec(item);
      if (!m) throw new Error(`Cannot parse import specifier "${item}"`);
      const imported = m[1]!.replace(/^["']|["']$/g, "");
      return [imported, m[2] ?? m[1]!] as [string, string];
    });
}

export const IMPORT_HELPERS = `
globalThis.__bwt_cjs_ns__ = (mod) => {
  if (mod && mod.__esModule && "default" in mod) return mod;
  const ns = {};
  for (const key in mod) ns[key] = mod[key];
  if (!("default" in mod)) ns.default = { ...ns };
  return ns;
};
`;

export { basename };
