// キーボードとマウスの入力。Playwright の server/input.ts と chromium/crInput.ts を
// Bun.WebView の cdp() の上に移植したもの。
// Adapted from Playwright (https://github.com/microsoft/playwright).
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.

import { macEditingCommands } from "./mac-editing-commands";
import { keypadLocation, USKeyboardLayout } from "./us-keyboard-layout";

type WebView = InstanceType<typeof Bun.WebView>;

export type Modifier = "Alt" | "Control" | "Meta" | "Shift";
export type Button = "left" | "right" | "middle";

interface KeyDescription {
  key: string;
  keyCode: number;
  keyCodeWithoutLocation: number;
  code: string;
  text: string;
  location: number;
  shifted?: KeyDescription;
}

const kModifiers: Modifier[] = ["Alt", "Control", "Meta", "Shift"];
const isMac = process.platform === "darwin";

const aliases = new Map<string, string[]>([
  ["ShiftLeft", ["Shift"]],
  ["ControlLeft", ["Control"]],
  ["AltLeft", ["Alt"]],
  ["MetaLeft", ["Meta"]],
  ["Enter", ["\n", "\r"]],
]);

const usKeyboardLayout = buildLayoutClosure();

function buildLayoutClosure(): Map<string, KeyDescription> {
  const result = new Map<string, KeyDescription>();
  for (const code in USKeyboardLayout) {
    const definition = USKeyboardLayout[code]!;
    const description: KeyDescription = {
      key: definition.key || "",
      keyCode: definition.keyCode || 0,
      keyCodeWithoutLocation: definition.keyCodeWithoutLocation || definition.keyCode || 0,
      code,
      text: definition.text || "",
      location: definition.location || 0,
    };
    if (definition.key.length === 1) description.text = description.key;
    let shiftedDescription: KeyDescription | undefined;
    if (definition.shiftKey) {
      shiftedDescription = { ...description };
      shiftedDescription.key = definition.shiftKey;
      shiftedDescription.text = definition.shiftKey;
      if (definition.shiftKeyCode) shiftedDescription.keyCode = definition.shiftKeyCode;
    }
    result.set(code, { ...description, shifted: shiftedDescription });
    for (const alias of aliases.get(code) ?? []) result.set(alias, description);
    if (definition.location) continue;
    if (description.key.length === 1) result.set(description.key, description);
    if (shiftedDescription) result.set(shiftedDescription.key, { ...shiftedDescription, shifted: undefined });
  }
  return result;
}

export function resolveSmartModifier(key: string): string {
  if (key === "ControlOrMeta") return isMac ? "Meta" : "Control";
  return key;
}

export function isKnownKey(key: string): boolean {
  return usKeyboardLayout.has(resolveSmartModifier(key));
}

function toModifiersMask(modifiers: Set<string>): number {
  let mask = 0;
  if (modifiers.has("Alt")) mask |= 1;
  if (modifiers.has("Control")) mask |= 2;
  if (modifiers.has("Meta")) mask |= 4;
  if (modifiers.has("Shift")) mask |= 8;
  return mask;
}

function toButtonsMask(buttons: Set<Button>): number {
  let mask = 0;
  if (buttons.has("left")) mask |= 1;
  if (buttons.has("right")) mask |= 2;
  if (buttons.has("middle")) mask |= 4;
  return mask;
}

/** 1 枚の WebView に対するキーボードとマウスの状態。Playwright の Keyboard / Mouse と同じ振る舞い。 */
export class Input {
  private pressedModifiers = new Set<Modifier>();
  private pressedKeys = new Set<string>();
  private x = 0;
  private y = 0;
  private lastButton: Button | "none" = "none";
  private buttons = new Set<Button>();
  private dragging: { data: unknown } | null = null;
  private interceptedDrag: Promise<unknown> | null = null;

  constructor(
    private readonly view: WebView,
    private readonly backend: "chrome" | "webkit",
  ) {}

  /** 押下中の入力やドラッグが残ったタブは、ファイル間で再利用しない。 */
  get isIdle(): boolean {
    return !this.pressedKeys.size && !this.buttons.size && !this.dragging && !this.dragListener;
  }

  private cdp(method: string, params: Record<string, unknown>) {
    if (this.backend !== "chrome") {
      throw new Error(`"${method}" needs the chrome backend (Bun.WebView backend: "chrome")`);
    }
    return this.view.cdp(method, params);
  }

  // ---- keyboard ----

  private describe(str: string): KeyDescription {
    const keyString = resolveSmartModifier(str);
    let description = usKeyboardLayout.get(keyString);
    if (!description) throw new Error(`Unknown key: "${keyString}"`);
    const shift = this.pressedModifiers.has("Shift");
    description = shift && description.shifted ? description.shifted : description;
    if (this.pressedModifiers.size > 1 || (!this.pressedModifiers.has("Shift") && this.pressedModifiers.size === 1)) {
      return { ...description, text: "" };
    }
    return description;
  }

  private commandsForCode(code: string): string[] {
    if (!isMac) return [];
    const parts: string[] = [];
    for (const m of kModifiers) if (this.pressedModifiers.has(m)) parts.push(m);
    parts.push(code);
    let commands = macEditingCommands[parts.join("+")] ?? [];
    if (typeof commands === "string") commands = [commands];
    return commands.filter((c) => !c.startsWith("insert")).map((c) => c.substring(0, c.length - 1));
  }

  async keyDown(key: string): Promise<void> {
    const description = this.describe(key);
    const autoRepeat = this.pressedKeys.has(description.code);
    this.pressedKeys.add(description.code);
    if (kModifiers.includes(description.key as Modifier)) this.pressedModifiers.add(description.key as Modifier);
    if (this.backend === "webkit") {
      // WebKit には keydown だけを送る API がないので、修飾キー以外は押した時点で 1 回分を送る
      if (!kModifiers.includes(description.key as Modifier)) {
        await this.view.press(description.key, { modifiers: [...this.pressedModifiers] });
      }
      return;
    }
    if (description.code === "Escape" && this.dragging) {
      await this.cdp("Input.dispatchDragEvent", { type: "dragCancel", x: this.x, y: this.y, data: this.dragging.data });
      this.dragging = null;
      return;
    }
    const { code, location, text } = description;
    await this.cdp("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      modifiers: toModifiersMask(this.pressedModifiers),
      windowsVirtualKeyCode: description.keyCodeWithoutLocation,
      code,
      commands: this.commandsForCode(code),
      key: description.key,
      text,
      unmodifiedText: text,
      autoRepeat,
      location,
      isKeypad: location === keypadLocation,
    });
  }

  async keyUp(key: string): Promise<void> {
    const description = this.describe(key);
    if (kModifiers.includes(description.key as Modifier)) this.pressedModifiers.delete(description.key as Modifier);
    this.pressedKeys.delete(description.code);
    if (this.backend === "webkit") return;
    await this.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: toModifiersMask(this.pressedModifiers),
      key: description.key,
      windowsVirtualKeyCode: description.keyCodeWithoutLocation,
      code: description.code,
      location: description.location,
    });
  }

  async insertText(text: string): Promise<void> {
    if (this.backend === "webkit") {
      await this.view.type(text);
      return;
    }
    await this.cdp("Input.insertText", { text });
  }

  async press(key: string): Promise<void> {
    const tokens: string[] = [];
    let building = "";
    for (const char of key) {
      if (char === "+" && building) {
        tokens.push(building);
        building = "";
      } else {
        building += char;
      }
    }
    tokens.push(building);
    const last = tokens.pop()!;
    for (const t of tokens) await this.keyDown(t);
    await this.keyDown(last);
    await this.keyUp(last);
    for (const t of tokens.reverse()) await this.keyUp(t);
  }

  /** 押しっぱなしの修飾キーを modifiers に合わせ、元の状態を返す。 */
  async ensureModifiers(modifiers: string[]): Promise<Modifier[]> {
    const wanted = modifiers.map(resolveSmartModifier);
    for (const m of wanted) if (!kModifiers.includes(m as Modifier)) throw new Error(`Unknown modifier ${m}`);
    const restore = [...this.pressedModifiers];
    for (const key of kModifiers) {
      const needDown = wanted.includes(key);
      const isDown = this.pressedModifiers.has(key);
      if (needDown && !isDown) await this.keyDown(key);
      else if (!needDown && isDown) await this.keyUp(key);
    }
    return restore;
  }

  get modifiers(): Set<Modifier> {
    return this.pressedModifiers;
  }

  // ---- mouse ----

  async mouseMove(x: number, y: number, steps = 1): Promise<void> {
    const fromX = this.x;
    const fromY = this.y;
    this.x = x;
    this.y = y;
    if (this.backend === "webkit") throw new Error("mouse move/hover needs the chrome backend");
    for (let i = 1; i <= steps; i++) {
      const mx = fromX + (x - fromX) * (i / steps);
      const my = fromY + (y - fromY) * (i / steps);
      if (this.dragging) {
        await this.cdp("Input.dispatchDragEvent", { type: "dragOver", x: mx, y: my, data: this.dragging.data, modifiers: toModifiersMask(this.pressedModifiers) });
        continue;
      }
      await this.cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        button: this.lastButton,
        buttons: toButtonsMask(this.buttons),
        x: mx,
        y: my,
        modifiers: toModifiersMask(this.pressedModifiers),
        force: this.buttons.size > 0 ? 0.5 : 0,
      });
      if (this.interceptedDrag) {
        // mousemove でドラッグが始まった場合、Chrome が Input.dragIntercepted を送ってくる
        const data = await Promise.race([this.interceptedDrag, Bun.sleep(10).then(() => null)]);
        if (data) {
          this.dragging = { data };
          this.interceptedDrag = null;
          await this.cdp("Input.dispatchDragEvent", { type: "dragEnter", x: mx, y: my, data, modifiers: toModifiersMask(this.pressedModifiers) });
          await this.cdp("Input.dispatchDragEvent", { type: "dragOver", x: mx, y: my, data, modifiers: toModifiersMask(this.pressedModifiers) });
        }
      }
    }
  }

  async mouseDown(button: Button = "left", clickCount = 1): Promise<void> {
    this.lastButton = button;
    this.buttons.add(button);
    if (this.backend === "webkit") throw new Error("mouse down/up needs the chrome backend");
    if (button === "left") await this.startDragInterception();
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button,
      buttons: toButtonsMask(this.buttons),
      x: this.x,
      y: this.y,
      modifiers: toModifiersMask(this.pressedModifiers),
      clickCount,
      force: this.buttons.size > 0 ? 0.5 : 0,
    });
  }

  async mouseUp(button: Button = "left", clickCount = 1): Promise<void> {
    this.lastButton = "none";
    this.buttons.delete(button);
    if (this.backend === "webkit") throw new Error("mouse down/up needs the chrome backend");
    if (this.dragging) {
      await this.cdp("Input.dispatchDragEvent", { type: "drop", x: this.x, y: this.y, data: this.dragging.data, modifiers: toModifiersMask(this.pressedModifiers) });
      this.dragging = null;
      await this.stopDragInterception();
      return;
    }
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button,
      buttons: toButtonsMask(this.buttons),
      x: this.x,
      y: this.y,
      modifiers: toModifiersMask(this.pressedModifiers),
      clickCount,
    });
    await this.stopDragInterception();
  }

  async click(x: number, y: number, options: { button?: Button; clickCount?: number } = {}): Promise<void> {
    const { button = "left", clickCount = 1 } = options;
    if (this.backend === "webkit") {
      await this.view.click(x, y, {
        button,
        clickCount: clickCount as 1 | 2 | 3,
        modifiers: [...this.pressedModifiers],
      });
      this.x = x;
      this.y = y;
      return;
    }
    this.x = x;
    this.y = y;
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: this.lastButton,
      buttons: toButtonsMask(this.buttons),
      x,
      y,
      modifiers: toModifiersMask(this.pressedModifiers),
    });
    for (let cc = 1; cc <= clickCount; ++cc) {
      this.lastButton = button;
      this.buttons.add(button);
      await this.cdp("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button,
        buttons: toButtonsMask(this.buttons),
        x,
        y,
        modifiers: toModifiersMask(this.pressedModifiers),
        clickCount: cc,
        force: 0.5,
      });
      this.lastButton = "none";
      this.buttons.delete(button);
      await this.cdp("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button,
        buttons: toButtonsMask(this.buttons),
        x,
        y,
        modifiers: toModifiersMask(this.pressedModifiers),
        clickCount: cc,
      });
    }
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    if (this.backend === "webkit") {
      await this.view.scroll(deltaX, deltaY);
      return;
    }
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: this.x,
      y: this.y,
      modifiers: toModifiersMask(this.pressedModifiers),
      deltaX,
      deltaY,
    });
  }

  // HTML5 ドラッグ＆ドロップ。Playwright の crDragDrop.ts と同じく Chrome にドラッグを横取りさせる。
  private dragListener: ((e: MessageEvent<{ data: unknown }>) => void) | null = null;

  private async startDragInterception() {
    if (this.backend !== "chrome") return;
    let resolve!: (data: unknown) => void;
    this.interceptedDrag = new Promise((r) => (resolve = r));
    this.dragListener = (e) => resolve(e.data.data);
    this.view.addEventListener("Input.dragIntercepted", this.dragListener as unknown as EventListener);
    await this.cdp("Input.setInterceptDrags", { enabled: true });
  }

  private async stopDragInterception() {
    if (this.backend !== "chrome" || !this.dragListener) return;
    this.view.removeEventListener("Input.dragIntercepted", this.dragListener as unknown as EventListener);
    this.dragListener = null;
    this.interceptedDrag = null;
    await this.cdp("Input.setInterceptDrags", { enabled: false });
  }

  /** テスト間の後始末。押しっぱなしのキーとボタンを離す。 */
  async releaseAll(keys: string[]): Promise<void> {
    for (const key of keys) {
      if (isKnownKey(key)) await this.keyUp(key).catch(() => {});
    }
  }
}
