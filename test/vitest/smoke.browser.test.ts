import { describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

describe("smoke", () => {
  test("renders and clicks", async () => {
    document.body.innerHTML = `<button>Click me</button><input placeholder="name">`;
    const fn = vi.fn();
    document.querySelector("button")!.addEventListener("click", fn);
    await page.getByRole("button", { name: "Click me" }).click();
    expect(fn).toHaveBeenCalledTimes(1);
    await userEvent.type(page.getByPlaceholder("name"), "hello");
    await expect.element(page.getByPlaceholder("name")).toHaveValue("hello");
  });

  test("expect.soft and assertion errors work", () => {
    expect(() => expect(1).toBe(2)).toThrowError("expected 1 to be 2");
  });

  test.skip("skipped", () => {});
});
