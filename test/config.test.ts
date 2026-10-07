import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cache = mkdtempSync(join(tmpdir(), "bwt-shell-detection-"));
afterAll(() => rmSync(cache, { recursive: true, force: true }));

function install(relative: string) {
  const path = join(cache, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return path;
}

// A subprocess keeps platform/environment changes out of other tests and preloads.
function config(platform: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, "-e", `
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
    const { getConfig } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
    console.log(JSON.stringify(getConfig()));
  `], {
    env: { ...process.env, BWT_BACKEND: "", BUN_CHROME_PATH: "", BWT_BROWSERS_PATH: "", BWT_BROWSER_VERSION: "", PLAYWRIGHT_BROWSERS_PATH: cache, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

for (const [platform, oldLayout, newLayout] of [
  ["darwin", "chrome-mac/headless_shell", "chrome-headless-shell-mac-arm64/chrome-headless-shell"],
  ["linux", "chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"],
  ["win32", "chrome-win/headless_shell.exe", "chrome-headless-shell-win64/chrome-headless-shell.exe"],
]) {
  test(`Headless Shell is the default on ${platform}, including legacy cache layouts`, () => {
    const isolated = join(cache, platform!);
    const oldPath = install(`${platform}/chromium_headless_shell-99/${oldLayout}`);
    expect(config(platform!, { PLAYWRIGHT_BROWSERS_PATH: isolated })).toMatchObject({ backend: "chrome", chromePath: oldPath });
    const newPath = install(`${platform}/chromium_headless_shell-100/${newLayout}`);
    install(`${platform}/chromium-101/${newLayout}`);
    install(`${platform}/chromium_headless_shell-102/other-platform/chrome-headless-shell`);
    expect(config(platform!, { PLAYWRIGHT_BROWSERS_PATH: isolated }).chromePath).toBe(newPath);
  });
}

test("explicit Chrome and WKWebView selections remain available", () => {
  expect(config("darwin", { BUN_CHROME_PATH: "/custom/chrome" })).toMatchObject({ backend: "chrome", chromePath: "/custom/chrome" });
  expect(config("darwin", { BWT_BACKEND: "webkit" }).backend).toBe("webkit");
});

test("missing Shell never falls back to an installed full Chrome", async () => {
  install("full-only/chromium-100/chrome-linux/chrome");
  expect(config("linux", { PLAYWRIGHT_BROWSERS_PATH: join(cache, "full-only") }).chromePath).toBeUndefined();
  expect(config("linux", { PLAYWRIGHT_BROWSERS_PATH: join(cache, "missing") }).chromePath).toBeUndefined();
  expect(config("linux", { PLAYWRIGHT_BROWSERS_PATH: "0" }).chromePath).toBeUndefined();
  const { chromeBackend } = await import("../src/chrome");
  await expect(chromeBackend(undefined, [])).rejects.toThrow("bunx bun-webview-test install");
});
