// vitest の test/browser/specs/errors.test.ts のうち、fixtures を使うものの移植
import { expect, test } from "bun:test";
import { runBrowserTests } from "./utils";

const LONG = 60_000;

test(
  "prints correct unhandled error stack",
  async () => {
    const { stderr, exitCode } = await runBrowserTests("unhandled");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("throw-unhandled-error.test.ts:9:11");
    expect(stderr).toContain('This error originated in "throw-unhandled-error.test.ts" test file.');
    expect(stderr).toContain('The last test to run before this error was "unhandled exception".');
  },
  LONG,
);

test(
  "disables tracking",
  async () => {
    const { stderr, exitCode } = await runBrowserTests("unhandled", { config: { trackUnhandledErrors: false } });
    expect(exitCode, stderr).toBe(0);
    expect(stderr).not.toContain("custom_unhandled_error");
  },
  LONG,
);

test(
  "print unhandled non error",
  async () => {
    const { stderr, results } = await runBrowserTests("unhandled-non-error");
    expect(stderr).toContain("[Error: ResizeObserver loop completed with undelivered notifications.]");
    expect(results).toEqual({ "ResizeObserver error": "pass" });
  },
  LONG,
);
