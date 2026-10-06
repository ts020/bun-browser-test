// スクリーンショットの前後にページ側でやること（撮る範囲の計算、mask、アニメーションとキャレットの停止）。
// Playwright の screenshotter.ts と同じ振る舞いにしている。
import { elementRect, resolveElement, type SerializedLocator } from "./actions";

export interface ScreenshotPrepareOptions {
  element?: SerializedLocator;
  target?: "page" | "element";
  mask?: SerializedLocator[];
  maskColor?: string;
  animations?: "disabled" | "allow";
  caret?: "hide" | "initial";
  fullPage?: boolean;
  timeout?: number;
  style?: string;
}

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

let cleanups: (() => void)[] = [];

export async function prepareScreenshot(options: ScreenshotPrepareOptions): Promise<{ clip?: Clip }> {
  finishScreenshot();
  const clip = options.element
    ? await elementRect(options.element, options)
    : options.target === "page"
      ? undefined
      : await elementRect({ selector: "html > body", locator: "locator('body')" }, options);
  if (options.caret !== "initial") hideCaret();
  if (options.animations === "disabled") disableAnimations();
  if (options.mask?.length) addMasks(options.mask, options.maskColor);
  if (options.style) addStyle(options.style);
  // スタイルの変更を描画に反映させる
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { clip };
}

export function finishScreenshot() {
  for (const fn of cleanups.splice(0).reverse()) fn();
}

function hideCaret() {
  const style = document.createElement("style");
  style.textContent = "*:not(#bwt-caret-hide) { caret-color: transparent !important; }";
  document.head.append(style);
  cleanups.push(() => style.remove());
}

function disableAnimations() {
  const style = document.createElement("style");
  style.textContent = `*:not(#bwt-animations),*::before,*::after {
  transition-delay: 0s !important; transition-duration: 0s !important;
  animation-delay: -0.0001s !important; animation-duration: 0s !important; animation-play-state: paused !important;
}`;
  document.head.append(style);
  const infinite: Animation[] = [];
  for (const animation of document.getAnimations()) {
    const timing = animation.effect?.getComputedTiming();
    if (timing && timing.endTime !== Number.POSITIVE_INFINITY) {
      try {
        animation.finish();
      } catch {}
    } else {
      animation.cancel();
      infinite.push(animation);
    }
  }
  cleanups.push(() => {
    style.remove();
    for (const animation of infinite) {
      try {
        animation.play();
      } catch {}
    }
  });
}

function addMasks(mask: SerializedLocator[], color = "#FF00FF") {
  const container = document.createElement("div");
  container.setAttribute("data-bwt-mask", "");
  for (const target of mask) {
    const el = resolveElement(target);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px;background:${color};z-index:2147483647;pointer-events:none`;
    container.append(box);
  }
  document.body.append(container);
  cleanups.push(() => container.remove());
}

function addStyle(css: string) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  cleanups.push(() => style.remove());
}
