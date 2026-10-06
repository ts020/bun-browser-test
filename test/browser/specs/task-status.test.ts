import { expect, test } from "bun:test";
import { runBrowserTests } from "./utils";

test("reports runtime skips and todos without adding tests", async () => {
  const { stderr, exitCode, results } = await runBrowserTests("task-status");
  expect(exitCode, stderr).toBe(0);
  expect(results).toEqual({
    control: "pass",
    "runtime skip": "skip",
    "async runtime skip": "skip",
    "static skip": "skip",
    "root todo": "todo",
    "pending suite > pending A": "todo",
    "pending suite > pending B": "todo",
    "pending suite > nested > pending C": "todo",
    "todo suite > pending D": "todo",
    "skipped suite > skipped child": "skip",
    "skipped suite > skipped todo": "todo",
    "beforeEach skip > first": "skip",
    "beforeEach skip > second": "skip",
  });
  expect(stderr).toContain("1 pass");
  expect(stderr).toContain("6 skip");
  expect(stderr).toContain("6 todo");
  expect(stderr).toContain("0 fail");
  expect(stderr).toContain("Ran 13 tests");
  expect(stderr).not.toContain("(unnamed)");
}, 60_000);
