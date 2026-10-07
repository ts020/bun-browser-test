import { expect, test } from "bun:test";
import { runBrowserTests } from "./utils";

const preload = ["./test/browser/fixtures/completion/preload.ts"];
const files = ["first.test.ts", "second.test.ts"];

test("waits for the completion response before reusing the page", async () => {
  const { stdout, stderr, exitCode, results } = await runBrowserTests("completion", { preload, files, isolate: false });
  expect(exitCode, stderr).toBe(0);
  expect(results).toEqual({ "first file completes": "pass", "second file completes": "pass" });
  expect(stdout).not.toContain("Page reused before completion response");
  expect(stderr).not.toContain("Failed to fetch");
}, 60_000);

test("still reports a rejected completion response", async () => {
  const { stderr, exitCode } = await runBrowserTests("completion", {
    preload, files: ["first.test.ts"], env: { COMPLETION_RESPONSE: "error" },
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Intentional completion response failure");
}, 60_000);

test("times out a stalled completion response and closes the page without reusing it", async () => {
  const { stdout, stderr, exitCode, results } = await runBrowserTests("completion", {
    preload, files, isolate: false, env: { COMPLETION_RESPONSE: "hang" },
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Timed out after 30000ms waiting for browser completion");
  expect(stdout).not.toContain("Page reused before completion response");
  expect(results["second file completes"]).toBe("pass");
}, 60_000);
