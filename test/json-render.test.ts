import { describe, expect, test } from "bun:test";
import { page, userEvent } from "../src";
import { renderToString, type Node } from "./fixtures/json-render";

const entry = new URL("./fixtures/json-render.ts", import.meta.url);

const doc: Node[] = [
  { type: "heading", level: 1, text: "Hello" },
  { type: "text", text: "Something went wrong", tone: "danger" },
  { type: "list", items: ["apple", "banana", "cherry"] },
  { type: "button", label: "Increment", action: "increment" },
  { type: "button", label: "Toggle list", action: "toggle" },
  { type: "input", label: "Your name", name: "name" },
];

describe("Bun で文字列にしてからブラウザで確かめる", () => {
  test("setContent で描画結果を見る", async () => {
    await page.setContent(renderToString(doc));
    await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent("Hello");
    await expect.element(page.getByRole("listitem")).toHaveCount(3);
    await expect.element(page.getByRole("listitem").nth(1)).toHaveTextContent("banana");
  });

  test("エスケープされている", async () => {
    await page.setContent(renderToString([{ type: "text", text: "<img src=x onerror=alert(1)>" }]));
    await expect.element(page.getByRole("img")).toHaveCount(0);
    await expect.element(page.getByText("<img src=x")).toBeVisible();
  });
});

describe("mount でモジュールをバンドルしてブラウザで動かす", () => {
  test("CSS も読み込まれる", async () => {
    await page.mount(entry, { nodes: doc });
    await expect.element(page.getByText("Something went wrong")).toHaveStyle({ color: "rgb(200, 0, 0)" });
    await expect.element(page.getByRole("heading", { name: "Hello" })).toHaveStyle({ "font-size": "32px" });
  });

  test("ネイティブクリック（isTrusted）で状態が変わる", async () => {
    await page.mount(entry, { nodes: doc });
    const button = page.getByRole("button", { name: "Increment" });
    await button.click();
    await userEvent.click(button);
    await expect.element(page.getByRole("status")).toHaveTextContent("count: 2");

    await page.getByRole("button", { name: /toggle/i }).click();
    await expect.element(page.getByRole("list")).not.toBeInTheDocument();
    await expect.element(page.getByRole("list", { includeHidden: true })).toBeHidden();
  });

  test("入力", async () => {
    await page.mount(entry, { nodes: doc });
    const input = page.getByLabelText("Your name");
    await input.fill("takanori");
    await expect.element(input).toHaveValue("takanori");
    await input.fill("bun");
    await expect.element(input).toHaveValue("bun");
    await userEvent.type(input, "{End}!{Backspace}?");
    await expect.element(input).toHaveValue("bun?");
    await expect.element(input).toBeFocused();
  });

  test("importModule で型付きのままページ内の関数を呼ぶ", async () => {
    await page.mount(entry, { nodes: doc });
    const mod = await page.importModule<typeof import("./fixtures/json-render")>(entry);
    const size = await mod.call("measure", "h1");
    expect(size.height).toBeGreaterThan(30);
    const html = await mod.call("renderToString", [{ type: "heading", level: 2, text: "x" }]);
    expect(html).toBe("<h2>x</h2>");
  });
});
