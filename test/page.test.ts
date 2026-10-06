import { beforeAll, describe, expect, test } from "bun:test";
import { configure, getSession, page, userEvent } from "../src";

// ブラウザの起動を最初のテストの時間に含めない（CI の Chrome は初回の起動に数秒かかる）
beforeAll(() => getSession(), 30_000);

describe("locator", () => {
  test("ロールと名前", async () => {
    await page.setContent(`
      <nav aria-label="Main"><a href="/a">Home</a><a href="/b">About</a></nav>
      <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com">
      <input type="checkbox" aria-label="Agree">
      <button aria-label="Close dialog">×</button>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Logo">
      <div data-testid="card"><span>inner</span></div>
    `);
    await expect.element(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveCount(2);
    await expect.element(page.getByRole("link", { name: "About" })).toHaveAttribute("href", "/b");
    await expect.element(page.getByRole("textbox", { name: "Email" })).toHaveAttribute("type", "email");
    await expect.element(page.getByPlaceholder("you@example")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Close dialog", exact: true })).toBeEnabled();
    await expect.element(page.getByAltText("Logo")).toHaveRole("img");
    await expect.element(page.getByTestId("card").getByText("inner")).toBeVisible();

    const agree = page.getByRole("checkbox", { name: "Agree" });
    await agree.check();
    await expect.element(agree).toBeChecked();
    await agree.uncheck();
    await expect.element(agree).not.toBeChecked();
  });

  test("filter / first / last / all", async () => {
    await page.setContent(`<ul>
      <li>apple <button>Buy</button></li>
      <li>banana <button>Buy</button></li>
      <li>cherry <button disabled>Buy</button></li>
    </ul>`);
    const items = page.getByRole("listitem");
    await expect.element(items.filter({ hasText: "banana" }).getByRole("button")).toBeEnabled();
    await expect.element(items.last().getByRole("button")).toBeDisabled();
    expect(await items.first().textContent()).toBe("apple Buy");
    expect((await items.all()).length).toBe(3);
    expect(await items.allTextContents()).toEqual(["apple Buy", "banana Buy", "cherry Buy"]);
  });

  test("要素が複数あると strict mode エラーになる", async () => {
    await page.setContent(`<button>a</button><button>b</button>`);
    await expect(page.getByRole("button").click()).rejects.toThrow(/strict mode violation/);
  });

  test("要素が後から現れるのを待つ", async () => {
    await page.setContent(`<script>setTimeout(() => {
      const b = document.createElement("button");
      b.textContent = "Later";
      b.onclick = () => b.textContent = "Clicked";
      document.body.append(b);
    }, 200)</script>`);
    await page.getByRole("button", { name: "Later" }).click();
    await expect.element(page.getByRole("button")).toHaveTextContent("Clicked");
  });

  test("expect.element は失敗するとわかりやすいメッセージを出す", async () => {
    await page.setContent(`<p>hello</p>`);
    let err: Error | undefined;
    try {
      await expect.element(page.getByText("hello"), { timeout: 100 }).toHaveTextContent("bye");
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain(`expect.element(page.getByText("hello")).toHaveTextContent("bye") failed`);
    expect(err?.message).toContain(`Received: "hello"`);
  });

  test("select / keyboard", async () => {
    await page.setContent(`
      <select aria-label="Fruit"><option value="a">Apple</option><option value="b">Banana</option></select>
      <textarea aria-label="Note"></textarea>`);
    await page.getByRole("combobox", { name: "Fruit" }).selectOptions("Banana");
    await expect.element(page.getByRole("combobox")).toHaveValue("b");
    await page.getByRole("textbox", { name: "Note" }).click();
    await userEvent.keyboard("line1{Enter}line2");
    await expect.element(page.getByRole("textbox")).toHaveValue("line1\nline2");
  });
});

describe("page", () => {
  test("evaluate に引数を渡す", async () => {
    await page.setContent(`<div id="x" style="width: 123px">x</div>`);
    const width = await page.evaluate((sel: string) => document.querySelector(sel)!.clientWidth, "#x");
    expect(width).toBe(123);
  });

  test("テストごとにページがリセットされる", async () => {
    expect(await page.evaluate(() => document.querySelector("#x"))).toBeNull();
  });

  test("viewport とスクリーンショット", async () => {
    await page.setViewport(400, 300);
    expect(await page.evaluate(() => innerWidth)).toBe(400);
    const png = await page.screenshot();
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    await page.setViewport(1280, 720);
  });

  test("ページ内の未捕捉例外を取り出せる", async () => {
    await page.setContent(`<button onclick="throw new Error('boom')">x</button>`);
    await page.getByRole("button").click();
    const errors = await page.takeErrors();
    expect(errors.map((e) => e.message).join()).toContain("boom");
  });

  test("hover (chrome のみ)", async () => {
    if (configure({}).backend !== "chrome") return;
    await page.setContent(`<style>button:hover { color: rgb(255, 0, 0) }</style><button>h</button>`);
    await page.getByRole("button").hover();
    await expect.element(page.getByRole("button")).toHaveStyle({ color: "rgb(255, 0, 0)" });
  });
});
