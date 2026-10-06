// vitest の test/browser/specs/timeout-actions.test.ts の移植
import { expect, test } from "bun:test";
import { errorOf, runBrowserTests } from "./utils";

const TIMED_OUT =
  'Test timed out in 500ms while waiting for screenshot.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".';

test(
  "task timeouts wait for pending actions",
  async () => {
    const { stderr, results } = await runBrowserTests("timeout-actions");
    expect(results).toEqual({
      "reports the action error when it arrives inside the grace": "fail",
      "names the pending action when it does not report back": "fail",
      "reports an action due after the test without waiting for it": "fail",
    });
    expect(errorOf(stderr, "reports the action error when it arrives inside the grace")).toContain("slow screenshot after 200ms");
    expect(errorOf(stderr, "reports an action due after the test without waiting for it")).toContain(TIMED_OUT);

    // the timeout error points at the pending action, not at the test
    const error = errorOf(stderr, "names the pending action when it does not report back");
    expect(error).toContain(TIMED_OUT);
    expect(error).toContain("actions.test.ts:9:14");
  },
  60_000,
);
