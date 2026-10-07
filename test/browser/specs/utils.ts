// vitest の test/browser/specs/utils.ts の runBrowserTests に相当。fixture を別プロセスの bun test で動かす。
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "../../..");

export interface RunResult {
  /** bun test の出力（色は取り除いてある） */
  stderr: string;
  stdout: string;
  exitCode: number;
  /** "(pass) name" / "(fail) name" から作った、テスト名と結果の対応 */
  results: Record<string, "pass" | "fail" | "skip" | "todo">;
}

export async function runBrowserTests(
  fixture: string,
  options: { config?: Record<string, unknown>; files?: string[]; isolate?: boolean } = {},
): Promise<RunResult> {
  const dir = `./test/browser/fixtures/${fixture}/`;
  const targets = options.files?.map((f) => `${dir}${f}`) ?? [dir];
  // AI エージェントの中で動いていると bun test は (pass) の行を省くので、その目印を外す。
  // GitHub Actions の中では失敗ごとに ::error 注釈を足して出力が変わるので、それも外す
  const { CLAUDECODE: _c, AI_AGENT: _a, AGENT: _g, GITHUB_ACTIONS: _gh, ...parentEnv } = process.env;
  const proc = Bun.spawn([process.execPath, "test", "--path-ignore-patterns=__none__", ...(options.isolate === false ? ["--no-isolate"] : []), ...targets], {
    cwd: PACKAGE_ROOT,
    env: {
      ...parentEnv,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ...(options.config ? { BWT_CONFIG: JSON.stringify(options.config) } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
  const results: RunResult["results"] = {};
  for (const m of strip(stderr).matchAll(/^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/gm)) {
    results[m[2]!] = m[1] as "pass";
  }
  return { stdout: strip(stdout), stderr: strip(stderr), exitCode, results };
}

/** 失敗したテストのエラー出力（"(fail) name" の直前のブロック）を取り出す。 */
export function errorOf(stderr: string, testName: string): string {
  const lines = stderr.split("\n");
  const end = lines.findIndex((l) => l.startsWith(`(fail) ${testName}`));
  if (end < 0) return "";
  let start = end - 1;
  while (start > 0 && !/^\((pass|fail|skip|todo)\) /.test(lines[start - 1]!) && !lines[start - 1]!.endsWith(".test.ts:")) start--;
  return lines.slice(start, end).join("\n").trim();
}
