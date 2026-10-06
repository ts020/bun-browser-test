// 公開用の型定義 (dist/*.d.ts) を作る。
// ソースは拡張子なしの相対 import を使っている（Bun と moduleResolution: "bundler" 向け）。
// moduleResolution: "node16" / "nodenext" の利用者でも型が解決できるよう、出力の相対 import に .js を付ける。
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Glob } from "bun";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", "tsconfig.build.json"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);

const specifier = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/g;
for await (const rel of new Glob("**/*.d.ts").scan(dist)) {
  const file = join(dist, rel);
  const src = await Bun.file(file).text();
  const out = src
    .split("\n")
    .map((line) => {
      // JSDoc の使用例などコメントの中は触らない
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return line;
      return line.replace(specifier, (all, head: string, q: string, spec: string) => {
        if (/\.(js|mjs|cjs|json)$/.test(spec)) return all;
        const base = resolve(dirname(file), spec);
        if (existsSync(`${base}.d.ts`)) return `${head}${q}${spec}.js${q}`;
        if (existsSync(join(base, "index.d.ts"))) return `${head}${q}${spec}/index.js${q}`;
        throw new Error(`${rel}: cannot resolve ${spec}`);
      });
    })
    .join("\n");
  if (out !== src) await Bun.write(file, out);
}
