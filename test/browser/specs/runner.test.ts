// vitest の test/browser/specs/runner.test.ts のうち、fixtures を使うものの移植
import { describe, expect, test } from "bun:test";
import { errorOf, runBrowserTests } from "./utils";

const LONG = 60_000;

test(
  "stack trace points to correct file in every browser when failed",
  async () => {
    const { stderr } = await runBrowserTests("failing");

    expect(stderr).toContain("expected 1 to be 2");
    expect(stderr).toMatch(/- 2\s+\+ 1/);
    expect(stderr).toContain("Failure screenshot");
    expect(stderr).toContain(".vitest/attachments/failure-screenshots/failing");

    expect(stderr).toContain('Access denied to "/inaccessible/path".');

    expect(stderr).toMatch(/failing.test.ts:11:13/);
    expect(stderr).toMatch(/throwError \(.*src\/error.ts:8:(13|9)\)/);

    expect(stderr).toContain(
      "The call was not awaited. This method is asynchronous and must be awaited; otherwise, the call will not start to avoid unhandled rejections.",
    );
    for (const line of [19, 20, 21]) expect(stderr).toMatch(new RegExp(`failing.test.ts:${line}:28`));
    for (let line = 22; line <= 35; line++) expect(stderr).toMatch(new RegExp(`failing.test.ts:${line}:13`));

    expect(stderr).toMatch(/bundled-lib\/src\/b.js:2:(9|18)/);
    expect(stderr).toMatch(/bundled-lib\/src\/index.js:5:(16|17)/);
    // index() is called from a bundled file
    expect(stderr).toMatch(/failing.test.ts:39:3/);

    // "not awaited but with then/catch/finally" test should not produce warnings
    expect(stderr).not.toMatch(/failing.test.ts:4[3-8]/);
  },
  LONG,
);

test(
  "timeout settings",
  async () => {
    const { stderr } = await runBrowserTests("timeout");
    expect(stderr).toContain("Matcher did not succeed in time.");
    expect(stderr).toContain("locator.click: Timeout 500ms exceeded.");
    expect(stderr).toContain("locator.click: Timeout 345ms exceeded.");
  },
  LONG,
);

describe("timeouts are reported for hooks", () => {
  test(
    "each failing hook names the click that timed out",
    async () => {
      const { stderr, results } = await runBrowserTests("timeout-hooks");
      const prefix = "timeouts are failing correctly > ";
      // vitest では beforeAll / afterAll の失敗はスイートに付く。Bun ではスイートの最初のテストか、スイートの afterAll として出る
      const expected: [name: string, location: string][] = [
        ["click on non-existing element fails", "hooks-timeout.test.ts:6:34"],
        ["beforeEach > skipped", "hooks-timeout.test.ts:15:46"],
        ["afterEach > skipped", "hooks-timeout.test.ts:23:46"],
        ["beforeAll > skipped", "hooks-timeout.test.ts:31:46"],
        ["onTestFinished > fails", "hooks-timeout.test.ts:48:48"],
        ["onTestFinished > fails global", "hooks-timeout.test.ts:54:48"],
        ["onTestFailed > fails", "hooks-timeout.test.ts:62:48"],
        ["onTestFailed > fails global", "hooks-timeout.test.ts:70:48"],
      ];
      for (const [name, location] of expected) {
        expect(results[prefix + name], name).toBe("fail");
        const error = errorOf(stderr, prefix + name);
        expect(error, name).toMatch(/TimeoutError: locator\.click: Timeout \d+ms exceeded\./);
        expect(error, name).toContain(location);
      }
      // afterAll はスイートのエラーとして出る
      expect(stderr).toMatch(/TimeoutError: locator\.click: Timeout \d+ms exceeded\.[\s\S]*hooks-timeout\.test\.ts:39:46/);
      expect(results[`${prefix}afterAll > skipped`]).toBe("pass");
      expect(stderr.match(/TimeoutError: locator\.click/g)?.length).toBe(9);
    },
    LONG,
  );
});

test(
  "viewport",
  async () => {
    const { stderr, results, exitCode } = await runBrowserTests("viewport");
    expect(exitCode, stderr).toBe(0);
    expect(Object.values(results)).not.toContain("fail");
  },
  LONG,
);
