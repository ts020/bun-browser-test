// bun test --isolate（--parallel も含む）では、テストファイルごとに global が作り直され、そのとき Bun.WebView が起動した Chrome も
// 終了する。ファイルごとに Chrome を起動し直すと 1 ファイルあたり数百 ms と CPU を使うので、Chrome をこちらで起動して
// プロセス（ワーカー）の中で使い回し、Bun.WebView はその DevTools の WebSocket につなぐ。
// global をまたいで残るのはファイルだけなので、つなぎ先はプロセス ID ごとのディレクトリに置く。

import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ChromeBackend = Extract<Bun.WebView.Backend, { type: "chrome" }>;

// Bun.WebView が Chrome を起動するときと同じ引数（--remote-debugging-pipe の代わりに --remote-debugging-port=0）
const DEFAULT_ARGS = [
  "--headless",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-ipc-flooding-protection",
  "--no-startup-window",
  "--remote-debugging-port=0",
];

/**
 * Bun.WebView の backend。Chrome の場所が分かっていれば、このプロセス用の Chrome を起動（起動済みなら再利用）してそこにつなぐ。
 * 場所が分からないときや Windows では、これまでどおり Bun.WebView に起動させる。
 */
export async function chromeBackend(path: string | undefined, argv: string[]): Promise<ChromeBackend> {
  if (!path || process.platform === "win32" || process.env.BWT_SHARED_CHROME === "0") {
    return { type: "chrome", url: false, path, argv };
  }
  const key = Bun.hash(JSON.stringify([path, argv])).toString(36);
  const dir = join(tmpdir(), `bun-webview-test-chrome-${process.pid}-${key}`);
  const url = (await connectable(dir)) ?? (await launch(dir, path, argv));
  return { type: "chrome", url };
}

/** dir の Chrome が生きていれば DevTools の WebSocket の URL を返す。 */
async function connectable(dir: string): Promise<string | null> {
  const file = join(dir, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  const [port, path] = readFileSync(file, "utf8").split("\n");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return `ws://127.0.0.1:${port}${path}`;
  } catch {}
  return null;
}

async function launch(dir: string, path: string, argv: string[]): Promise<string> {
  rmSync(dir, { recursive: true, force: true });
  // Bun.spawn の子プロセスは global と一緒に終了させられるので、sh から切り離して起動する。
  // 同じ sh がこのプロセスの終了を見張り、終わったら Chrome を止めてディレクトリを消す。
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const chrome = [path, `--user-data-dir=${dir}`, ...DEFAULT_ARGS, ...argv].map(q).join(" ");
  const script =
    `(${chrome} >/dev/null 2>&1 & c=$!; ` +
    `while kill -0 ${process.pid} 2>/dev/null && kill -0 $c 2>/dev/null; do sleep 0.1; done; ` +
    `kill $c 2>/dev/null; wait $c 2>/dev/null; rm -rf ${q(dir)}) >/dev/null 2>&1 &`;
  Bun.spawnSync(["sh", "-c", script], { stdio: ["ignore", "ignore", "ignore"] });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const url = await connectable(dir);
    if (url) return url;
    await Bun.sleep(10);
  }
  throw new Error(`bun-webview-test: Chrome did not start (${path})`);
}
