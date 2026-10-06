// bunfig.toml の [test] preload に入れて使う（vitest ブラウザモード互換）。
// ブラウザで動かすテストファイル（config.include に一致するもの）を Bun では実行せず、
// 「ページ内で実行して結果を bun test に報告する」スタブに差し替える。
import { plugin } from "bun";
import { join } from "node:path";
import { resolveFileConfig } from "./config";

const host = join(import.meta.dir, "host.ts");

plugin({
  name: "bun-webview-test:vitest",
  setup(build) {
    build.onLoad({ filter: /\.(test|spec)\.[cm]?[jt]sx?$/ }, async ({ path, loader }) => {
      const source = await Bun.file(path).text();
      const { include } = await resolveFileConfig(path);
      const matched = typeof include === "function" ? include(path, source) : include.test(path);
      if (!matched) return { contents: source, loader: loader as any };
      return {
        contents: `import { runBrowserTestFile } from ${JSON.stringify(host)};\nawait runBrowserTestFile(${JSON.stringify(path)});\n`,
        loader: "ts",
      };
    });
  },
});
