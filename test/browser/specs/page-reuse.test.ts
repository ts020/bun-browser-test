import { expect, test } from "bun:test";
import { runBrowserTests } from "./utils";

test("reused Chrome tabs isolate documents and discard custom browser state", async () => {
  const { stderr, exitCode, results } = await runBrowserTests("page-reuse", {
    isolate: false,
    files: ["first.test.ts", "second.test.ts", "custom-view.test.ts", "cdp.test.ts", "last.test.ts"],
  });
  expect(exitCode, stderr).toBe(0);
  expect(results).toEqual({
    "fresh document: first": "pass",
    "fresh document: second": "pass",
    "fresh document: custom view": "pass",
    "fresh document: cdp": "pass",
    "fresh document: last": "pass",
  });
}, 60_000);
