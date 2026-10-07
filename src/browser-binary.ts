import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Keep the browser fixed across OSes and repeated installs of this package version.
export const HEADLESS_SHELL_VERSION = "145.0.7632.6";

export function browserCacheRoot(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");
  if (process.platform === "win32") return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

export function headlessShellPlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `mac-${arch}`;
  if (platform === "linux" && arch === "x64") return "linux64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && arch === "x64") return "win64";
  if (platform === "win32" && arch === "ia32") return "win32";
  return undefined;
}

export function headlessShellInstallation() {
  const version = process.env.BWT_BROWSER_VERSION || HEADLESS_SHELL_VERSION;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("BWT_BROWSER_VERSION must be an exact Chrome version, such as 145.0.7632.6.");
  }
  const platform = headlessShellPlatform();
  if (!platform) return undefined;
  const cache = process.env.BWT_BROWSERS_PATH
    ? resolve(process.env.BWT_BROWSERS_PATH)
    : join(browserCacheRoot(), "bun-webview-test");
  const directory = join(cache, `${version}-${platform}`);
  const folder = `chrome-headless-shell-${platform}`;
  const executable = join(directory, folder, `chrome-headless-shell${platform.startsWith("win") ? ".exe" : ""}`);
  return { version, platform, cache, directory, folder, executable };
}

type Installation = NonNullable<ReturnType<typeof headlessShellInstallation>>;

function isInstalled(installation: Installation): boolean {
  return existsSync(join(installation.directory, ".complete"))
    && existsSync(installation.executable) && statSync(installation.executable).isFile();
}

export function installedHeadlessShell(): string | undefined {
  const installation = headlessShellInstallation();
  return installation && isInstalled(installation) ? installation.executable : undefined;
}

/** Explicit installation only: importing this module never downloads or launches anything. */
export async function installHeadlessShell(): Promise<string> {
  const installation = headlessShellInstallation();
  if (!installation) {
    throw new Error(`No Chrome Headless Shell download for ${process.platform}/${process.arch}. Set BUN_CHROME_PATH to a compatible browser.`);
  }
  if (isInstalled(installation)) return installation.executable;
  if (existsSync(installation.directory)) {
    throw new Error(`Incomplete browser cache at ${installation.directory}. Remove that directory and run the install command again.`);
  }
  const { cache, version, platform, folder } = installation;
  const extractor = process.platform === "win32" ? "powershell.exe" : "unzip";
  if (!Bun.which(extractor)) throw new Error(`Install ${extractor} before downloading Headless Shell.`);
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, ".download-"));
  try {
    const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/${folder}.zip`;
    console.log(`Downloading Chrome Headless Shell ${version} (${platform})…`);
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Headless Shell download failed: HTTP ${response.status} (${url}). Check that this version is published for ${platform}.`);
    }
    const archive = join(staging, "browser.zip");
    await Bun.write(archive, response);
    // GCS publishes a base64 MD5 for transfer integrity; HTTPS authenticates the source.
    const expected = response.headers.get("x-goog-hash")?.match(/(?:^|[,\s])md5=([^,\s]+)/)?.[1];
    if (expected) {
      const hash = createHash("md5");
      for await (const chunk of createReadStream(archive)) hash.update(chunk);
      if (hash.digest("base64") !== expected) throw new Error("Headless Shell download checksum mismatch. Retry the install command.");
    }
    const args = process.platform === "win32"
      ? [extractor, "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:BWT_ARCHIVE -DestinationPath $env:BWT_EXTRACT_DIR"]
      : [extractor, "-q", archive, "-d", staging];
    const child = Bun.spawn(args, {
      env: { ...process.env, BWT_ARCHIVE: archive, BWT_EXTRACT_DIR: staging },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Could not extract Headless Shell: ${stderr.trim()}`);
    const stagedExecutable = join(staging, folder, `chrome-headless-shell${platform.startsWith("win") ? ".exe" : ""}`);
    if (!existsSync(stagedExecutable) || !statSync(stagedExecutable).isFile()) {
      throw new Error("Headless Shell archive did not contain the expected executable.");
    }
    if (process.platform !== "win32") await chmod(stagedExecutable, 0o755);
    await rm(archive);
    await writeFile(join(staging, ".complete"), `${version}\n`);
    try {
      // Publish only a complete directory. Concurrent installs can share the winner.
      await rename(staging, installation.directory);
    } catch (error) {
      if (!isInstalled(installation)) throw error;
    }
    return installation.executable;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
