import { expect, test } from "bun:test";
import { runBrowserTests } from "./utils";

for (const parallel of [undefined, 4]) {
  test(`browser engine and file isolation (${parallel ?? 1} workers, no-isolate)`, async () => {
    const result = await runBrowserTests("engine", { isolate: false, parallel });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(Object.keys(result.results)).toHaveLength(8);
    expect(Object.values(result.results).every(value => value === "pass")).toBe(true);
  }, 120_000);
}

test("browser assertion failures produce a failing Bun exit and source location", async () => {
  const result = await runBrowserTests("failing", { files: ["failing.test.ts"], config: { screenshotFailures: false } });
  expect(result.exitCode, result.stderr).not.toBe(0);
  expect(result.stderr).toContain("expected 1 to be 2");
  expect(result.stderr).toContain("failing.test.ts:11:13");
  expect(Object.values(result.results)).toContain("fail");
}, 60_000);

test.skipIf(process.env.BWT_BACKEND !== "firefox")("Firefox configuration and executable precedence", async () => {
  const { detectFirefoxPath } = await import("../../../src/vitest/firefox");
  const executable = detectFirefoxPath()!;
  for (const override of [false, true]) {
    const result = await runBrowserTests("engine", {
      files: ["first.test.ts"],
      config: { backend: override ? "chrome" : "firefox", firefoxPath: override ? "/missing/firefox" : executable },
      env: {
        BWT_BACKEND: override ? "firefox" : "",
        BWT_FIREFOX_PATH: override ? executable : "",
        BWT_EXPECT_BACKEND: "firefox",
      },
    });
    expect(result.exitCode, result.stderr).toBe(0);
  }
}, 60_000);

test.skipIf(process.env.BWT_BACKEND !== "firefox")("missing Firefox executable reports installation guidance", async () => {
  const result = await runBrowserTests("engine", {
    files: ["first.test.ts"], env: { BWT_FIREFOX_PATH: "/missing/firefox" },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Could not launch Firefox");
  expect(result.stderr).toContain("Install a current Firefox release");
}, 60_000);

test.skipIf(process.env.BWT_BACKEND !== "firefox")("Firefox closes its browser after use", async () => {
  const { FirefoxView } = await import("../../../src/vitest/firefox");
  const { getBrowserModeConfig } = await import("../../../src/vitest/config");
  const view = await FirefoxView.start(getBrowserModeConfig());
  try {
    expect(await view.evaluate<string>("navigator.userAgent")).toContain("Firefox/");
    await expect(view.capture({ omitBackground: true })).rejects.toThrow(/omitBackground/);
    await view.navigate('data:text/html,<div style="height:100px">screenshot</div>');
    const png = Buffer.from(await view.capture({ clip: { x: 0, y: 0, width: 40, height: 30 } }), "base64");
    expect(png.readUInt32BE(16)).toBe(40);
    expect(png.readUInt32BE(20)).toBe(30);
  } finally {
    await view.close();
  }
  await expect(view.evaluate("1")).rejects.toThrow(/closed/);
}, 30_000);

test.skipIf(process.env.BWT_BACKEND !== "firefox")("Firefox process exit rejects pending evaluation and cleans its profile", async () => {
  const { existsSync } = await import("node:fs");
  const { FirefoxView } = await import("../../../src/vitest/firefox");
  const { getBrowserModeConfig } = await import("../../../src/vitest/config");
  const view = await FirefoxView.start(getBrowserModeConfig());
  const profile = view["profile"];
  try {
    const pending = view.evaluate("new Promise(() => {})").catch(error => error);
    view["process"].kill("SIGKILL");
    expect((await view.disconnected).message).toMatch(/closed|exited/);
    expect(await pending).toBeInstanceOf(Error);
  } finally {
    await view.close();
  }
  expect(existsSync(profile)).toBe(false);
}, 30_000);
