// ページで動くランタイム（vitest 本体 + @vitest/browser のクライアント + このパッケージのテスター）を Bun.build で 1 回だけビルドし、
// コード分割したチャンクを import map で `vitest` などの名前に割り当てる。
// テストファイルなどは devserver.ts が 1 ファイルずつ変換し、`vitest` 系の import はこのランタイムを指したままにする。
// こうするとテストファイルとランタイムが同じモジュールのインスタンスを共有する。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { BunPlugin } from "bun";

const here = import.meta.dir;
const clientDir = join(here, "client");
const vitestBrowserPkg = dirname(Bun.resolveSync("@vitest/browser/package.json", here));
// Bun.build は outdir に書き出すので、一時ディレクトリを使う
const outRoot = mkdtempSync(join(tmpdir(), "bun-webview-test-"));
let outSeq = 0;
const nextOutdir = () => join(outRoot, String(++outSeq));

export interface Output {
  body: ArrayBuffer | string;
  type: string;
}

export interface BuiltModule {
  /** エントリのパス（/__bwt/... から始まる） */
  entry: string;
  css: string[];
  files: Map<string, Output>;
  sourceMap?: any;
}

/** テストファイルから見て external にするモジュールと、それを指すランタイムのエントリ。 */
export const SHARED_MODULES: Record<string, string> = {
  vitest: "vitest.js",
  "vitest/browser": "vitest-browser.js",
  "@vitest/browser/context": "vitest-browser.js",
  "vitest/internal/browser": "vitest-internal-browser.js",
  "@vitest/browser/locators": "browser-locators.js",
};

const runtimeResolver: BunPlugin = {
  name: "bwt-runtime",
  setup(build) {
    build.onResolve({ filter: /^(vitest\/browser|@vitest\/browser\/context)$/ }, () => ({
      path: join(clientDir, "vitest-browser.ts"),
    }));
    build.onResolve({ filter: /^bwt:browser-context$/ }, () => ({ path: join(vitestBrowserPkg, "dist/context.js") }));
    build.onResolve({ filter: /^bwt:expect-element$/ }, () => ({
      path: join(vitestBrowserPkg, "dist/expect-element.js"),
    }));
  },
};

async function collect(outputs: Bun.BuildArtifact[], prefix: string, outdir: string) {
  const files = new Map<string, Output>();
  let entry = "";
  const css: string[] = [];
  let sourceMap: any;
  for (const out of outputs) {
    const rel = relative(outdir, out.path).replaceAll("\\", "/");
    const path = `${prefix}${rel}`;
    files.set(path, { body: await out.arrayBuffer(), type: out.type });
    if (out.kind === "entry-point") entry = path;
    else if (out.kind === "sourcemap") {
      if (!sourceMap) sourceMap = JSON.parse(await out.text());
    } else if (rel.endsWith(".css")) css.push(path);
  }
  return { entry, css, files, sourceMap };
}

let runtime: Promise<Map<string, Output>> | null = null;

export function buildRuntime(): Promise<Map<string, Output>> {
  runtime ??= (async () => {
    const outdir = nextOutdir();
    const result = await Bun.build({
      entrypoints: [
        join(clientDir, "state.ts"),
        join(clientDir, "tester.ts"),
        join(clientDir, "vitest-browser.ts"),
        join(clientDir, "entries/vitest.ts"),
        join(clientDir, "entries/vitest-internal-browser.ts"),
        join(clientDir, "entries/browser-locators.ts"),
      ],
      outdir,
      target: "browser",
      format: "esm",
      splitting: true,
      naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
      plugins: [runtimeResolver],
      define: {
        "process.env.NODE_ENV": JSON.stringify("test"),
        "import.meta.env": "globalThis.__vitest_worker__.metaEnv",
      },
      throw: false,
    });
    if (!result.success) throw new AggregateError(result.logs, "bun-webview-test: failed to build the browser runtime");
    const { files } = await collect(result.outputs, "/__bwt/rt/", outdir);
    return files;
  })();
  return runtime;
}

export function importMap(): string {
  const imports: Record<string, string> = {};
  for (const [name, file] of Object.entries(SHARED_MODULES)) imports[name] = `/__bwt/rt/${file}`;
  return JSON.stringify({ imports });
}
