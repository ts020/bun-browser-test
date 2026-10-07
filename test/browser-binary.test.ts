import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { headlessShellInstallation, headlessShellPlatform, installHeadlessShell, installedHeadlessShell } from "../src/browser-binary";
import { detectChromePath } from "../src/config";

const archive = await Bun.file(new URL("./fixtures/headless-shell.zip", import.meta.url)).arrayBuffer();
const digest = createHash("md5").update(Buffer.from(archive)).digest("base64");
let cache: string;
let download: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  previous = Object.fromEntries(["BWT_BROWSERS_PATH", "BWT_BROWSER_VERSION", "BUN_CHROME_PATH", "PLAYWRIGHT_BROWSERS_PATH"].map((key) => [key, process.env[key]]));
  cache = mkdtempSync(join(tmpdir(), "bwt-download-"));
  process.env.BWT_BROWSERS_PATH = cache;
  delete process.env.BWT_BROWSER_VERSION;
  delete process.env.BUN_CHROME_PATH;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  const fetchArchive = Object.assign(
    async () => new Response(archive, { headers: { "x-goog-hash": `crc32c=unused, md5=${digest}` } }),
    { preconnect: fetch.preconnect },
  );
  download = spyOn(globalThis, "fetch").mockImplementation(fetchArchive);
});

afterEach(() => {
  download.mockRestore();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(cache, { recursive: true, force: true });
});

test("installs into a complete cache, detects it, and reuses it without a request", async () => {
  expect(installedHeadlessShell()).toBeUndefined();
  const executable = await installHeadlessShell();
  expect(await Bun.file(executable).text()).toContain("Test fixture");
  expect(detectChromePath()).toBe(executable);
  expect(await installHeadlessShell()).toBe(executable);
  expect(download).toHaveBeenCalledTimes(1);
  expect(readdirSync(cache)).toEqual([`${headlessShellInstallation()!.version}-${headlessShellInstallation()!.platform}`]);
  process.env.BUN_CHROME_PATH = "/explicit/browser";
  expect(detectChromePath()).toBe("/explicit/browser");
});

test("a failed request leaves no cache entry and can be retried", async () => {
  download.mockResolvedValueOnce(new Response("missing", { status: 404 }));
  await expect(installHeadlessShell()).rejects.toThrow("HTTP 404");
  expect(readdirSync(cache)).toEqual([]);
  expect(detectChromePath()).toBeUndefined();
  expect(existsSync(await installHeadlessShell())).toBe(true);
});

test("corrupt downloads never become installed browsers", async () => {
  download.mockResolvedValueOnce(new Response(archive, { headers: { "x-goog-hash": "md5=wrong" } }));
  await expect(installHeadlessShell()).rejects.toThrow("checksum mismatch");
  expect(readdirSync(cache)).toEqual([]);
  download.mockResolvedValueOnce(new Response("not a zip"));
  await expect(installHeadlessShell()).rejects.toThrow("Could not extract");
  expect(readdirSync(cache)).toEqual([]);
});

test("concurrent downloads publish the same complete installation", async () => {
  const paths = await Promise.all([installHeadlessShell(), installHeadlessShell()]);
  expect(paths[0]).toBe(paths[1]);
  expect(installedHeadlessShell()).toBe(paths[0]);
  expect(readdirSync(cache)).toHaveLength(1);
});

test("version overrides select a separate cache and reject path input before downloading", async () => {
  const first = await installHeadlessShell();
  process.env.BWT_BROWSER_VERSION = "155.0.8059.39";
  expect(installedHeadlessShell()).toBeUndefined();
  expect(detectChromePath()).toBeUndefined();
  const second = await installHeadlessShell();
  expect(second).not.toBe(first);
  expect(detectChromePath()).toBe(second);
  process.env.BWT_BROWSER_VERSION = "../../outside";
  await expect(installHeadlessShell()).rejects.toThrow("exact Chrome version");
  expect(download).toHaveBeenCalledTimes(2);
});

test("platform selection never silently substitutes another architecture", () => {
  expect(headlessShellPlatform("darwin", "arm64")).toBe("mac-arm64");
  expect(headlessShellPlatform("darwin", "x64")).toBe("mac-x64");
  expect(headlessShellPlatform("linux", "x64")).toBe("linux64");
  expect(headlessShellPlatform("linux", "arm64")).toBe("linux-arm64");
  expect(headlessShellPlatform("win32", "x64")).toBe("win64");
  expect(headlessShellPlatform("win32", "ia32")).toBe("win32");
  expect(headlessShellPlatform("win32", "arm64")).toBeUndefined();
  expect(headlessShellPlatform("freebsd", "x64")).toBeUndefined();
});

test("CLI help and invalid commands do not download a browser", () => {
  for (const [arg, expected] of [["--help", 0], ["unknown", 1]] as const) {
    const result = Bun.spawnSync([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, arg], {
      env: process.env, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(expected);
    expect(result.stdout.toString()).toContain("Usage: bun-webview-test install");
    expect(readdirSync(cache)).toEqual([]);
  }
});
