#!/usr/bin/env bun
import { HEADLESS_SHELL_VERSION, installHeadlessShell } from "./browser-binary";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "install") {
  try {
    console.log(`Headless Shell ready: ${await installHeadlessShell()}`);
  } catch (error) {
    console.error(`bun-webview-test: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else {
  console.log(`Usage: bun-webview-test install

Download Chrome Headless Shell ${HEADLESS_SHELL_VERSION} directly from Chrome for Testing.
Existing complete downloads are reused. No browser is downloaded by bun install.

Environment:
  BWT_BROWSERS_PATH     Browser cache directory (default: OS cache/bun-webview-test)
  BWT_BROWSER_VERSION   Exact Chrome version; use the same value when running tests

Requires unzip on macOS/Linux, or PowerShell on Windows.
Linux system libraries must be installed separately.`);
  if (args.length && !(args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) process.exitCode = 1;
}
