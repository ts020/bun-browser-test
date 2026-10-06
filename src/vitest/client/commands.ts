// vitest のブラウザコマンド（__vitest_click など）の実装。
// vitest 本体ではテスターから Node 側のプロバイダー（Playwright）へ送られるものを、
// 要素の解決と actionability はページ内で、入力そのものは Bun 側の CDP で処理する。

// @ts-ignore
import { defaultKeyMap } from "@testing-library/user-event/dist/esm/keyboard/keyMap.js";
// @ts-ignore
import { parseKeyDef } from "@testing-library/user-event/dist/esm/keyboard/parseKeyDef.js";
import {
  click,
  dragAndDrop,
  fill,
  focus,
  hover,
  input,
  type InputOp,
  resolveElement,
  selectOptions,
  selectText,
  type SerializedLocator,
  setInputFiles,
  wheel,
} from "./actions";
import { boot } from "./boot";
import { rpc } from "./rpc";
import { finishScreenshot, prepareScreenshot } from "./screenshot";
import { getWorkerState } from "./state";

// Playwright の US キーボードにあるキー。これ以外は insertText で入力する（vitest の playwright プロバイダーと同じ）。
const VALID_KEYS = new Set([
  "Escape", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "Backquote", "`", "~",
  "Digit1", "1", "!", "Digit2", "2", "@", "Digit3", "3", "#", "Digit4", "4", "$", "Digit5", "5", "%", "Digit6", "6",
  "^", "Digit7", "7", "&", "Digit8", "8", "*", "Digit9", "9", "(", "Digit0", "0", ")", "Minus", "-", "_", "Equal",
  "=", "+", "Backslash", "\\", "|", "Backspace", "Tab", "KeyQ", "q", "Q", "KeyW", "w", "W", "KeyE", "e", "E", "KeyR",
  "r", "R", "KeyT", "t", "T", "KeyY", "y", "Y", "KeyU", "u", "U", "KeyI", "i", "I", "KeyO", "o", "O", "KeyP", "p",
  "P", "BracketLeft", "[", "{", "BracketRight", "]", "}", "CapsLock", "KeyA", "a", "A", "KeyS", "s", "S", "KeyD",
  "d", "D", "KeyF", "f", "F", "KeyG", "g", "G", "KeyH", "h", "H", "KeyJ", "j", "J", "KeyK", "k", "K", "KeyL", "l",
  "L", "Semicolon", ";", ":", "Quote", "'", '"', "Enter", "\n", "\r", "ShiftLeft", "Shift", "KeyZ", "z", "Z", "KeyX",
  "x", "X", "KeyC", "c", "C", "KeyV", "v", "V", "KeyB", "b", "B", "KeyN", "n", "N", "KeyM", "m", "M", "Comma", ",",
  "<", "Period", ".", ">", "Slash", "/", "?", "ShiftRight", "ControlLeft", "Control", "MetaLeft", "Meta", "AltLeft",
  "Alt", "Space", " ", "AltRight", "AltGraph", "MetaRight", "ContextMenu", "ControlRight", "PrintScreen",
  "ScrollLock", "Pause", "PageUp", "PageDown", "Insert", "Delete", "Home", "End", "ArrowLeft", "ArrowUp",
  "ArrowRight", "ArrowDown", "NumLock", "NumpadDivide", "NumpadMultiply", "NumpadSubtract", "Numpad7", "Numpad8",
  "Numpad9", "Numpad4", "Numpad5", "Numpad6", "NumpadAdd", "Numpad1", "Numpad2", "Numpad3", "Numpad0",
  "NumpadDecimal", "NumpadEnter", "ControlOrMeta",
]);

async function keyboardImplementation(
  pressed: Set<string>,
  text: string,
  selectAll: () => void,
  skipRelease: boolean,
): Promise<void> {
  const actions = parseKeyDef(defaultKeyMap, text) as {
    keyDef: { key?: string };
    releasePrevious: boolean;
    releaseSelf: boolean;
    repeat: number;
  }[];
  let ops: InputOp[] = [];
  const flush = async () => {
    if (ops.length) await input(ops);
    ops = [];
  };
  for (const { releasePrevious, releaseSelf, repeat, keyDef } of actions) {
    const key = keyDef.key!;
    if (pressed.has(key)) {
      if (VALID_KEYS.has(key)) ops.push(["up", key]);
      pressed.delete(key);
    }
    if (releasePrevious) continue;
    if (key === "selectall") {
      await flush();
      selectAll();
      continue;
    }
    for (let i = 1; i <= repeat; i++) {
      ops.push(VALID_KEYS.has(key) ? ["down", key] : ["insertText", key]);
    }
    if (releaseSelf) {
      if (VALID_KEYS.has(key)) ops.push(["up", key]);
    } else {
      pressed.add(key);
    }
  }
  if (!skipRelease && pressed.size) {
    for (const key of pressed) if (VALID_KEYS.has(key)) ops.push(["up", key]);
  }
  await flush();
}

function focusDocument() {
  if (!document.activeElement || document.activeElement === document.body) window.focus();
}

function selectActiveElement() {
  const element = document.activeElement as HTMLInputElement | null;
  if (element && typeof element.select === "function") element.select();
}

type Handler = (...args: any[]) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  __vitest_click: (target: SerializedLocator, options = {}) => click(target, options),
  __vitest_dblClick: (target: SerializedLocator, options = {}) => click(target, options, 2),
  __vitest_tripleClick: (target: SerializedLocator, options = {}) => click(target, options, 3),
  __vitest_hover: (target: SerializedLocator, options = {}) => hover(target, options),
  __vitest_fill: (target: SerializedLocator, text: string, options = {}) => fill(target, text, options),
  __vitest_clear: (target: SerializedLocator, options = {}) => fill(target, "", options),
  __vitest_selectOptions: (target: SerializedLocator, values, options = {}) => selectOptions(target, values, options),
  __vitest_wheel: (target: SerializedLocator, options: { delta: { x?: number; y?: number }; times?: number }) =>
    wheel(target, options.delta, options.times ?? 1),
  __vitest_dragAndDrop: (source: SerializedLocator, target: SerializedLocator, options = {}) =>
    dragAndDrop(source, target, options),
  async __vitest_upload(target: SerializedLocator, files: (string | { name: string; mimeType: string; base64: string })[], options = {}) {
    const resolved = await Promise.all(
      files.map(async (file) => {
        if (typeof file !== "string") return file;
        const info = await rpc<{ content: string; basename: string; mime: string }>("fileInfo", file);
        return { name: info.basename, mimeType: info.mime, base64: info.content };
      }),
    );
    await setInputFiles(target, resolved, options);
  },
  async __vitest_type(target: SerializedLocator, text: string, options: any = {}) {
    const { skipClick = false, skipAutoClose = false } = options;
    const unreleased = new Set<string>(options.unreleased ?? []);
    const element = skipClick ? resolveElement(target) : await focus(target, options);
    await keyboardImplementation(unreleased, text, () => element && selectText(element), skipAutoClose);
    return { unreleased: [...unreleased] };
  },
  async __vitest_keyboard(text: string, state: { unreleased: string[] }) {
    focusDocument();
    const pressed = new Set(state.unreleased);
    await keyboardImplementation(pressed, text, selectActiveElement, true);
    return { unreleased: [...pressed] };
  },
  async __vitest_tab(options: { shift?: boolean } = {}) {
    await input([["press", options.shift === true ? "Shift+Tab" : "Tab"]]);
  },
  async __vitest_cleanup(state: { unreleased: string[] }) {
    if (!state?.unreleased?.length) return;
    await input(state.unreleased.filter((k) => VALID_KEYS.has(k)).map((k) => ["up", k] as InputOp));
  },
  async __vitest_screenshot(name: string, options: any = {}) {
    options.save ??= true;
    if (!options.save) options.base64 = true;
    const { element, mask, ...rest } = options;
    try {
      const { clip } = await prepareScreenshot({ ...rest, element, mask, caret: rest.caret ?? "hide" });
      const { path, base64 } = await rpc<{ path: string; base64: string }>("screenshot", name, {
        ...rest,
        clip,
        testPath: getWorkerState().filepath,
      });
      if (!options.save) return base64;
      if (options.base64) return { path, base64 };
      return path;
    } finally {
      finishScreenshot();
    }
  },
  // 追跡（trace）は未対応。呼ばれても何もしない。
  __vitest_markTrace: async () => {},
  __vitest_groupTraceStart: async () => {},
  __vitest_groupTraceEnd: async () => {},
  __vitest_startTracing: async () => {},
  __vitest_startChunkTrace: async () => {},
  __vitest_stopChunkTrace: async () => ({ tracePath: "" }),
  __vitest_annotateTraces: async () => {},
  __vitest_deleteTracing: async () => {},
  __vitest_recordBrowserTrace: async () => {},
};

export async function triggerCommand(command: string, args: unknown[], clientError: Error = new Error("empty")) {
  // 設定の commands で上書きされた組み込みコマンドは Bun 側で動かす
  const handler = boot.commands.includes(command) ? undefined : handlers[command];
  try {
    if (handler) return await handler(...args);
    return await rpc("command", command, getWorkerState().filepath ?? getWorkerState().current?.file?.filepath, args);
  } catch (err: any) {
    // 呼び出し元のスタックを残す（vitest の CommandsManager と同じ）
    clientError.message = err.message;
    clientError.name = err.name;
    clientError.stack = clientError.stack?.replace("empty", err.message).replace("STACK_TRACE_ERROR", err.message);
    throw clientError;
  }
}
