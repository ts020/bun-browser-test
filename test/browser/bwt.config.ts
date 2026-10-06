// vitest の test/browser/vitest.config.mts を移植したもの
import { stripVTControlCharacters } from "node:util";
import { defineConfig } from "../../src/vitest/config";

export default defineConfig({
  define: {
    "import.meta.env.DEFINE_CUSTOM_ENV": JSON.stringify("define-custom-env"),
  },
  env: {
    CUSTOM_ENV: "foo",
  },
  server: {
    headers: {
      "x-custom": "hello",
    },
    // vitest.config.mts の my-ssr プラグイン
    async middleware(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) return undefined;
      const mod = await import("./test/server/entry.ts");
      return new Response(JSON.stringify(await mod.default(url)));
    },
  },
  optimizeDeps: {
    include: ["@vitest/cjs-lib", "@vitest/bundled-lib"],
  },
  testerHtmlPath: "./custom-tester.html",
  alias: {
    "#src": "./src",
    // vitest の test/browser では link: で入れているローカルのパッケージ
    "@vitest/cjs-lib": "./cjs-lib",
    "@vitest/bundled-lib": "./bundled-lib",
  },
  commands: {
    myCustomCommand: ({ testPath }, arg1: string, arg2: string) => ({ testPath, arg1, arg2 }),
    stripVTControlCharacters: (_, text: string) => stripVTControlCharacters(text),
  },
});
