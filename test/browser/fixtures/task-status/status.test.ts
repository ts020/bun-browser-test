import { afterAll, beforeEach, describe, expect, test } from "vitest";

function mustNotRun() {
  throw new Error("a skipped body must not continue");
}

test("control", () => expect(1).toBe(1));
test("runtime skip", ({ skip }) => {
  skip();
  mustNotRun();
});
test("async runtime skip", async ({ skip }) => {
  await Promise.resolve();
  skip();
  mustNotRun();
});
test.skip("static skip", mustNotRun);
test.todo("root todo", mustNotRun);

describe("pending suite", () => {
  test.todo("pending A", mustNotRun);
  test.todo("pending B", mustNotRun);
  describe("nested", () => {
    test.todo("pending C", mustNotRun);
  });
});
describe.todo("todo suite", () => {
  test("pending D", mustNotRun);
});
describe.skip("skipped suite", () => {
  afterAll(mustNotRun);
  test("skipped child", mustNotRun);
  test.todo("skipped todo", mustNotRun);
});
describe("beforeEach skip", () => {
  beforeEach(({ skip }) => skip());
  test("first", mustNotRun);
  test("second", mustNotRun);
});
