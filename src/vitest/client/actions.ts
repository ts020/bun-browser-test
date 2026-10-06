// userEvent / Locator の操作をページ内で解決する部分。
// Playwright の locator 操作（actionability の待ち、hit target の確認、fill / selectOption など）を
// injectedScript.ts と dom.ts の振る舞いに合わせて実装し、実際の入力は Bun 側の CDP で送る。
// Behaviour adapted from Playwright (https://github.com/microsoft/playwright),
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.

// @ts-ignore
import { selectorEngine } from "@vitest/browser/locators";
import { asLocator } from "ivya";
import { getAriaDisabled, getAriaRole, isElementVisible } from "ivya/utils";
import { rpc } from "./rpc";
import { getBrowserState, getWorkerState } from "./state";

export interface SerializedLocator {
  selector: string;
  locator: string;
}

export type InputOp =
  | ["down" | "up" | "press" | "insertText", string]
  | ["click", number, number, { button?: string; clickCount?: number }]
  | ["move", number, number, number?]
  | ["mouseDown" | "mouseUp", string?]
  | ["wheel", number, number]
  | ["modifiers", string[]];

// テストがフェイクタイマーを使っても影響を受けないよう、読み込み時のものを確保しておく
const _setTimeout = globalThis.setTimeout.bind(globalThis);
const _raf = globalThis.requestAnimationFrame.bind(globalThis);
const _now = Date.now;

const sleep = (ms: number) => new Promise<void>((r) => _setTimeout(r, ms));
const nextFrame = () => new Promise<void>((r) => _raf(() => r()));

export function input(ops: InputOp[]): Promise<unknown> {
  return rpc("input", ops);
}

class NonRetryableError extends Error {}

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

const RETRY = Symbol("retry");
type Retry = typeof RETRY;

interface Progress {
  log(line: string): void;
}

/**
 * vitest の resolveActionTimeout と同じ優先順位: 明示指定 → プロバイダーの actionTimeout →
 * 実行中のテスト/フックの残り時間（タスクのタイムアウトより先に分かりやすいエラーで落ちるように）。
 */
function resolveActionTimeout(timeout: number | undefined): number | undefined {
  if (timeout != null) return timeout;
  const actionTimeout = getWorkerState()?.config?.browser?.providerOptions?.actionTimeout;
  if (actionTimeout != null) return actionTimeout;
  return getBrowserState()?.runner?._deadline?.derive();
}

/** Playwright のリトライ間隔に合わせた待ちループ。 */
async function retrying<T>(
  apiName: string,
  timeout: number | undefined,
  fn: (progress: Progress, attempt: number) => Promise<T | Retry>,
): Promise<T> {
  timeout = resolveActionTimeout(timeout);
  const deadline = timeout ? _now() + timeout : Number.POSITIVE_INFINITY;
  const logs: string[] = [];
  let lastLog = "";
  const progress: Progress = {
    log(line) {
      if (line !== lastLog) logs.push(`  - ${line}`);
      lastLog = line;
    },
  };
  const waits = [0, 20, 100, 100, 500];
  for (let attempt = 0; ; attempt++) {
    let result: T | Retry;
    try {
      result = await fn(progress, attempt);
    } catch (e) {
      if (e instanceof NonRetryableError) {
        const err = new Error(`${apiName}: ${e.message}`);
        throw err;
      }
      throw e;
    }
    if (result !== RETRY) return result;
    const left = deadline - _now();
    if (left <= 0) {
      throw new TimeoutError(`${apiName}: Timeout ${timeout}ms exceeded.\nCall log:\n${logs.join("\n")}\n`);
    }
    await sleep(Math.min(waits[Math.min(attempt, waits.length - 1)]!, left));
  }
}

// ---- 要素の解決 ----

function strictModeViolation(locator: string, matches: Element[]): NonRetryableError {
  const infos = matches.slice(0, 10).map((m) => ({
    preview: selectorEngine.previewNode(m),
    selector: selectorEngine.generateSelectorSimple(m),
  }));
  const lines = infos.map((info, i) => `\n    ${i + 1}) ${info.preview} aka ${asLocator("javascript", info.selector)}`);
  if (infos.length < matches.length) lines.push("\n    ...");
  return new NonRetryableError(`strict mode violation: ${locator} resolved to ${matches.length} elements:${lines.join("")}\n`);
}

function query(target: SerializedLocator, progress: Progress): Element | Retry {
  const parsed = selectorEngine.parseSelector(target.selector);
  const elements: Element[] = selectorEngine.querySelectorAll(parsed, document);
  if (elements.length > 1) throw strictModeViolation(target.locator, elements);
  if (elements.length === 0) {
    progress.log(`waiting for ${target.locator}`);
    return RETRY;
  }
  return elements[0]!;
}

export function resolveElement(target: SerializedLocator): Element | null {
  const parsed = selectorEngine.parseSelector(target.selector);
  const elements: Element[] = selectorEngine.querySelectorAll(parsed, document);
  if (elements.length > 1) throw new Error(strictModeViolation(target.locator, elements).message);
  return elements[0] ?? null;
}

type Retarget = "none" | "follow-label" | "no-follow-label" | "button-link";

function retarget(node: Node, behavior: Retarget): Element | null {
  let element: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return null;
  if (behavior === "none") return element;
  if (!element.matches("input, textarea, select") && !(element as HTMLElement).isContentEditable) {
    if (behavior === "button-link") element = element.closest("button, [role=button], a, [role=link]") || element;
    else element = element.closest("button, [role=button], [role=checkbox], [role=radio]") || element;
  }
  if (behavior === "follow-label") {
    if (
      !element.matches(
        "a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=switch], [role=radio]",
      ) &&
      !(element as HTMLElement).isContentEditable
    ) {
      const enclosingLabel = element.closest("label") as HTMLLabelElement | null;
      if (enclosingLabel?.control) element = enclosingLabel.control;
    }
  }
  return element;
}

const kAriaReadonlyRoles = [
  "checkbox", "combobox", "grid", "gridcell", "listbox", "radiogroup", "slider", "spinbutton", "textbox", "columnheader", "rowheader", "searchbox", "switch", "treegrid",
];

function getReadonly(element: Element): boolean | "error" {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.nodeName)) return element.hasAttribute("readonly");
  if (kAriaReadonlyRoles.includes(getAriaRole(element) || "")) return element.getAttribute("aria-readonly") === "true";
  if ((element as HTMLElement).isContentEditable) return false;
  return "error";
}

type State = "visible" | "enabled" | "editable" | "stable";

async function checkStates(element: Element, states: State[], progress: Progress): Promise<boolean> {
  for (const state of states) {
    if (state === "stable") {
      // バウンディングボックスが 2 フレーム続けて変わらなければ安定とみなす
      const r1 = element.getBoundingClientRect();
      await nextFrame();
      const r2 = element.getBoundingClientRect();
      if (r1.top !== r2.top || r1.left !== r2.left || r1.width !== r2.width || r1.height !== r2.height) {
        progress.log("element is not stable");
        return false;
      }
      continue;
    }
    if (!element.isConnected) {
      progress.log("element is not attached to the DOM");
      return false;
    }
    if (state === "visible") {
      if (!isElementVisible(element)) {
        progress.log("element is not visible");
        return false;
      }
      continue;
    }
    const target = retarget(element, "follow-label")!;
    if (state === "enabled") {
      if (getAriaDisabled(target)) {
        progress.log("element is not enabled");
        return false;
      }
      continue;
    }
    if (state === "editable") {
      const readonly = getReadonly(target);
      if (readonly === "error") {
        throw new NonRetryableError(
          "Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]",
        );
      }
      if (getAriaDisabled(target) || readonly) {
        progress.log("element is not editable");
        return false;
      }
    }
  }
  return true;
}

const scrollOptions: (ScrollIntoViewOptions | undefined)[] = [
  undefined,
  { block: "end", inline: "end" },
  { block: "center", inline: "center" },
  { block: "start", inline: "start" },
];

function scrollIntoViewIfNeeded(element: Element, attempt: number) {
  const forced = scrollOptions[attempt % scrollOptions.length];
  if (forced) {
    element.scrollIntoView({ ...forced, behavior: "instant" });
    return;
  }
  const anyEl = element as any;
  if (typeof anyEl.scrollIntoViewIfNeeded === "function") anyEl.scrollIntoViewIfNeeded(true);
  else element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
}

function clickablePoint(element: Element): { x: number; y: number } | null {
  const doc = element.ownerDocument;
  const vw = doc.documentElement.clientWidth || doc.defaultView!.innerWidth;
  const vh = doc.documentElement.clientHeight || doc.defaultView!.innerHeight;
  for (const rect of element.getClientRects()) {
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, vw);
    const bottom = Math.min(rect.bottom, vh);
    if ((right - left) * (bottom - top) > 0.99) return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
  return null;
}

function offsetPoint(element: Element, offset: { x: number; y: number }) {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    x: box.left + Number.parseFloat(style.borderLeftWidth || "0") + offset.x,
    y: box.top + Number.parseFloat(style.borderTopWidth || "0") + offset.y,
  };
}

function parentElementOrShadowHost(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const parent = element.parentNode;
  if (parent && parent.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */ && (parent as ShadowRoot).host) {
    return (parent as ShadowRoot).host;
  }
  return null;
}

function deepElementFromPoint(doc: Document, x: number, y: number): Element | null {
  let container: Document | ShadowRoot = doc;
  let element: Element | null = null;
  for (;;) {
    const inner: Element | null = container.elementFromPoint(x, y);
    if (!inner || element === inner) break;
    element = inner;
    if (!element.shadowRoot) break;
    container = element.shadowRoot;
  }
  return element;
}

/**
 * iframe の中の要素の座標（その iframe の中での座標）を、いちばん外側のページの座標に直す。
 * 途中の iframe が別の要素に隠れていればその理由を返す。
 */
function toTopLevelPoint(element: Element, point: { x: number; y: number }): { x: number; y: number } | string {
  let { x, y } = point;
  for (let frame = element.ownerDocument.defaultView?.frameElement; frame; frame = frame.ownerDocument.defaultView?.frameElement) {
    const rect = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView!.getComputedStyle(frame);
    x += rect.left + frame.clientLeft + Number.parseFloat(style.paddingLeft || "0");
    y += rect.top + frame.clientTop + Number.parseFloat(style.paddingTop || "0");
    const hit = deepElementFromPoint(frame.ownerDocument, x, y);
    if (hit !== frame) return hit ? `${selectorEngine.previewNode(retarget(hit, "none")!)} intercepts pointer events` : "element is outside of the viewport";
  }
  return { x, y };
}

function expectHitTarget(point: { x: number; y: number }, target: Element): true | string {
  const hit = deepElementFromPoint(target.ownerDocument, point.x, point.y);
  if (!hit) return "element is outside of the viewport";
  for (let e: Element | null = hit; e; e = parentElementOrShadowHost(e)) {
    if (e === target) return true;
  }
  const hitTarget = retarget(hit, "none")!;
  return `${selectorEngine.previewNode(hitTarget)} intercepts pointer events`;
}

export interface PointerOptions {
  timeout?: number;
  force?: boolean;
  trial?: boolean;
  position?: { x: number; y: number };
  modifiers?: string[];
  button?: "left" | "right" | "middle";
  clickCount?: number;
  steps?: number;
}

/** click / hover の共通部分。要素が操作できる状態になるまで待ち、操作する座標を返す。 */
async function pointerTarget(
  apiName: string,
  target: SerializedLocator,
  options: PointerOptions,
  waitForEnabled: boolean,
): Promise<{ x: number; y: number } | null> {
  return retrying(apiName, options.timeout, async (progress, attempt) => {
    const element = query(target, progress);
    if (element === RETRY) return RETRY;
    if (!options.force) {
      const states: State[] = waitForEnabled ? ["visible", "enabled", "stable"] : ["visible", "stable"];
      if (!(await checkStates(element, states, progress))) return RETRY;
    }
    scrollIntoViewIfNeeded(element, attempt);
    const point = options.position ? offsetPoint(element, options.position) : clickablePoint(element);
    if (!point) {
      progress.log("element is not visible");
      return RETRY;
    }
    if (!options.force) {
      const hit = expectHitTarget(point, element);
      if (hit !== true) {
        progress.log(hit);
        return RETRY;
      }
    }
    const top = toTopLevelPoint(element, point);
    if (typeof top === "string") {
      if (!options.force) {
        progress.log(top);
        return RETRY;
      }
    }
    if (options.trial) return null;
    return typeof top === "string" ? point : top;
  });
}

async function withModifiers(modifiers: string[] | undefined, ops: InputOp[]): Promise<void> {
  if (!modifiers?.length) {
    await input(ops);
    return;
  }
  await input([["modifiers", modifiers], ...ops, ["modifiers", []]]);
}

export async function click(target: SerializedLocator, options: PointerOptions = {}, clickCount = options.clickCount ?? 1) {
  const api = clickCount === 2 ? "locator.dblclick" : "locator.click";
  const point = await pointerTarget(api, target, options, true);
  if (!point) return;
  await withModifiers(options.modifiers, [["click", point.x, point.y, { button: options.button, clickCount }]]);
}

export async function hover(target: SerializedLocator, options: PointerOptions = {}) {
  const point = await pointerTarget("locator.hover", target, options, false);
  if (!point) return;
  await withModifiers(options.modifiers, [["move", point.x, point.y]]);
}

export async function wheel(target: SerializedLocator, delta: { x?: number; y?: number }, times = 1) {
  await hover(target, {});
  const ops: InputOp[] = [];
  for (let i = 0; i < times; i++) ops.push(["wheel", delta.x ?? 0, delta.y ?? 0]);
  await input(ops);
}

export async function dragAndDrop(
  source: SerializedLocator,
  target: SerializedLocator,
  options: { timeout?: number; force?: boolean; sourcePosition?: { x: number; y: number }; targetPosition?: { x: number; y: number }; steps?: number } = {},
) {
  const from = await pointerTarget("locator.dragTo", source, { ...options, position: options.sourcePosition }, false);
  if (!from) return;
  await input([["move", from.x, from.y], ["mouseDown", "left"]]);
  const to = await pointerTarget("locator.dragTo", target, { ...options, position: options.targetPosition }, false);
  if (!to) return;
  await input([["move", to.x, to.y, options.steps ?? 1], ["mouseUp", "left"]]);
}

// ---- 入力欄 ----

export function selectText(element: Element) {
  if (element instanceof HTMLInputElement) {
    element.select();
    element.focus();
    return;
  }
  if (element instanceof HTMLTextAreaElement) {
    element.selectionStart = 0;
    element.selectionEnd = element.value.length;
    element.focus();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  (element as HTMLElement).focus();
}

const kInputTypesToSetValue = new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]);
const kInputTypesToTypeInto = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);

function prepareFill(element: Element, value: string): "done" | "needsinput" {
  if (element.nodeName.toLowerCase() === "input") {
    const inputEl = element as HTMLInputElement;
    const type = inputEl.type.toLowerCase();
    if (!kInputTypesToTypeInto.has(type) && !kInputTypesToSetValue.has(type)) {
      throw new NonRetryableError(`Input of type "${type}" cannot be filled`);
    }
    if (type === "number") {
      value = value.trim();
      if (Number.isNaN(Number(value))) throw new NonRetryableError("Cannot type text into input[type=number]");
    }
    if (kInputTypesToSetValue.has(type)) {
      value = value.trim();
      inputEl.focus();
      inputEl.value = value;
      if (inputEl.value !== value) throw new NonRetryableError("Malformed value");
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return "done";
    }
  } else if (element.nodeName.toLowerCase() === "textarea") {
    // ok
  } else if (!(element as HTMLElement).isContentEditable) {
    throw new NonRetryableError("Element is not an <input>, <textarea> or [contenteditable] element");
  }
  selectText(element);
  return "needsinput";
}

export async function fill(target: SerializedLocator, value: string, options: { timeout?: number; force?: boolean } = {}) {
  const result = await retrying("locator.fill", options.timeout, async (progress) => {
    const found = query(target, progress);
    if (found === RETRY) return RETRY;
    const element = retarget(found, "follow-label")!;
    if (!options.force && !(await checkStates(element, ["visible", "enabled", "editable"], progress))) return RETRY;
    return prepareFill(element, value);
  });
  if (result === "needsinput") {
    await input(value ? [["insertText", value]] : [["press", "Delete"]]);
  }
}

export async function focus(target: SerializedLocator, options: { timeout?: number } = {}): Promise<Element> {
  return retrying("locator.focus", options.timeout, async (progress) => {
    const element = query(target, progress);
    if (element === RETRY) return RETRY;
    (element as HTMLElement).focus();
    return element;
  });
}

type OptionToSelect = string | { element: SerializedLocator };

export async function selectOptions(
  target: SerializedLocator,
  values: OptionToSelect[],
  options: { timeout?: number; force?: boolean } = {},
): Promise<string[]> {
  return retrying("locator.selectOption", options.timeout, async (progress) => {
    const found = query(target, progress);
    if (found === RETRY) return RETRY;
    const element = retarget(found, "follow-label")!;
    if (!options.force && !(await checkStates(element, ["visible", "enabled"], progress))) return RETRY;
    if (element.nodeName.toLowerCase() !== "select") throw new NonRetryableError("Element is not a <select> element");
    const toSelect: (string | Element)[] = [];
    for (const v of values) {
      if (typeof v === "string") {
        toSelect.push(v);
        continue;
      }
      const el = resolveElement(v.element);
      if (!el) {
        progress.log(`waiting for ${v.element.locator}`);
        return RETRY;
      }
      toSelect.push(el);
    }
    const select = element as HTMLSelectElement;
    const all = [...select.options];
    const selected: HTMLOptionElement[] = [];
    let remaining = toSelect.slice();
    for (const option of all) {
      const filter = (o: string | Element) => (o instanceof Node ? option === o : o === option.value || o === option.label);
      if (!remaining.some(filter)) continue;
      selected.push(option);
      if (select.multiple) {
        remaining = remaining.filter((o) => !filter(o));
      } else {
        remaining = [];
        break;
      }
    }
    if (remaining.length) {
      progress.log("did not find some options");
      return RETRY;
    }
    select.value = undefined as unknown as string;
    for (const option of selected) option.selected = true;
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return selected.map((o) => o.value);
  });
}

export async function setInputFiles(
  target: SerializedLocator,
  files: { name: string; mimeType: string; base64: string }[],
  options: { timeout?: number } = {},
) {
  await retrying("locator.setInputFiles", options.timeout, async (progress) => {
    const found = query(target, progress);
    if (found === RETRY) return RETRY;
    const element = retarget(found, "follow-label")!;
    if (element.nodeName !== "INPUT") throw new NonRetryableError("Node is not an HTMLInputElement");
    const inputEl = element as HTMLInputElement;
    if (inputEl.type !== "file") throw new NonRetryableError("Not an input[type=file]");
    if (files.length > 1 && !inputEl.multiple) throw new NonRetryableError("Non-multiple file input can only accept single file");
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.mimeType, lastModified: _now() }));
    }
    inputEl.files = dt.files;
    inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
}

/** スクリーンショット用に要素の矩形を求める（ページ座標）。 */
export async function elementRect(target: SerializedLocator, options: { timeout?: number } = {}) {
  return retrying("locator.screenshot", options.timeout, async (progress, attempt) => {
    const element = query(target, progress);
    if (element === RETRY) return RETRY;
    if (!(await checkStates(element, ["visible", "stable"], progress))) return RETRY;
    if (attempt === 0) scrollIntoViewIfNeeded(element, 0);
    const r = element.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  });
}
