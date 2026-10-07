import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";

afterEach(() => document.body.replaceChildren());

async function pixel(base64: string, x = 10, y = 10) {
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  return [...context.getImageData(x, y, 1, 1).data];
}

test("screenshots include temporary styles and masks without stale pixels", async () => {
  document.body.innerHTML = '<div id="paint-box" data-testid="paint-box" style="width:100px;height:100px;background:rgb(255,0,0)"></div>';
  const box = page.getByTestId("paint-box");
  for (const [css, rgb] of [
    ["rgb(0,0,255)", [0, 0, 255, 255]],
    ["rgb(0,255,0)", [0, 255, 0, 255]],
    ["rgb(255,0,255)", [255, 0, 255, 255]],
  ] as const) {
    const image = await box.screenshot({ save: false, style: `#paint-box { background: ${css} !important; }` });
    expect(await pixel(image)).toEqual([...rgb]);
    expect(getComputedStyle(document.getElementById("paint-box")!).backgroundColor).toBe("rgb(255, 0, 0)");
  }
  const masked = await box.screenshot({ save: false, mask: [box], maskColor: "#00ffff" });
  expect(await pixel(masked)).toEqual([0, 255, 255, 255]);
  expect(document.querySelector("[data-bwt-mask]")).toBeNull();
  expect(await pixel(await box.screenshot({ save: false }))).toEqual([255, 0, 0, 255]);
});

test("screenshots capture the finished state of disabled animations", async () => {
  document.body.innerHTML = '<div id="paint-box" data-testid="paint-box" style="width:100px;height:100px;background:red"></div>';
  const element = document.getElementById("paint-box")!;
  element.animate([{ backgroundColor: "red" }, { backgroundColor: "blue" }], {
    duration: 60_000,
    fill: "forwards",
  });
  const image = await page.getByTestId("paint-box").screenshot({ save: false, animations: "disabled" });
  expect(await pixel(image)).toEqual([0, 0, 255, 255]);
});
