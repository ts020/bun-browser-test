import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserModeConfig } from "./config";
import { resolveSmartModifier, type Button, type Modifier } from "./input";
import { USKeyboardLayout } from "./us-keyboard-layout";

export function detectFirefoxPath(): string | undefined {
  if (process.env.BWT_FIREFOX_PATH) return process.env.BWT_FIREFOX_PATH;
  const onPath = Bun.which("firefox");
  if (onPath) return onPath;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Firefox.app/Contents/MacOS/firefox", join(homedir(), "Applications/Firefox.app/Contents/MacOS/firefox")]
    : process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map(dir => join(dir!, "Mozilla Firefox", "firefox.exe"))
      : [];
  return candidates.find(path => existsSync(path));
}

type FirefoxProcess = Bun.Subprocess<"ignore", "ignore", "pipe">;
type Pending = { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** A regular Firefox, controlled directly over WebDriver BiDi. One temporary profile per file. */
export class FirefoxView {
  readonly input = new FirefoxInput(this);
  private reportDisconnect!: (error: Error) => void;
  readonly disconnected = new Promise<Error>(resolve => { this.reportDisconnect = resolve; });
  private socket?: WebSocket;
  private context = "";
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private state: "starting" | "open" | "disconnected" | "closing" | "closed" = "starting";
  private stderr = "";

  private constructor(
    private readonly process: FirefoxProcess,
    private readonly profile: string,
    private readonly forwardConsole: boolean,
  ) {
    globalThis.process.once("exit", this.onExit);
    void this.process.exited.then(code => {
      this.disconnect(new Error(`Firefox process exited (${code})`));
      this.socket?.close();
    });
  }

  // Also cover abrupt Bun exit; normal teardown awaits the browser and removes its profile.
  private onExit = () => {
    this.process.kill("SIGKILL");
    try { rmSync(this.profile, { recursive: true, force: true }); } catch {}
  };

  static async start(config: BrowserModeConfig): Promise<FirefoxView> {
    const executable = process.env.BWT_FIREFOX_PATH || config.firefoxPath || detectFirefoxPath();
    if (!executable) throw new Error("bun-webview-test: Firefox was not found. Install Firefox from https://www.mozilla.org/firefox/ or set BWT_FIREFOX_PATH / firefoxPath to its executable.");
    // These flags control the profile and connection owned by this session.
    if (config.firefoxArgs.some(arg => /^--?(?:profile|p|remote-debugging-port|remote-allow-hosts|remote-allow-origins)(?:=|$)/i.test(arg))) {
      throw new Error("bun-webview-test: firefoxArgs cannot override the managed profile or remote debugging connection.");
    }
    const profile = await mkdtemp(join(tmpdir(), "bun-webview-test-firefox-"));
    let view: FirefoxView | undefined;
    try {
      await writeFile(join(profile, "user.js"), [
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("browser.startup.page", 0);',
        'user_pref("browser.startup.homepage", "about:blank");',
        'user_pref("browser.newtabpage.enabled", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("app.normandy.enabled", false);',
        'user_pref("app.shield.optoutstudies.enabled", false);',
        'user_pref("messaging-system.rsexperimentloader.enabled", false);',
      ].join("\n"));
      const child = Bun.spawn([executable, ...config.firefoxArgs, ...(config.headless ? ["--headless"] : []),
        "--no-remote", "--profile", profile, "--remote-debugging-port=0", "about:blank"], {
        stdin: "ignore", stdout: "ignore", stderr: "pipe",
      });
      view = new FirefoxView(child, profile, config.forwardConsole);
      await view.connect();
      await view.send("session.new", { capabilities: {} });
      if (config.forwardConsole) await view.send("session.subscribe", { events: ["log.entryAdded"] });
      const { context } = await view.send("browsingContext.create", { type: "tab" });
      if (typeof context !== "string") throw new Error("Firefox did not return a browsing context");
      view.context = context;
      await view.resize(config.viewport.width, config.viewport.height);
      await view.send("browsingContext.activate", { context });
      return view;
    } catch (cause) {
      await view?.close();
      await rm(profile, { recursive: true, force: true });
      throw new Error("bun-webview-test: Could not launch Firefox. Install a current Firefox release or set BWT_FIREFOX_PATH / firefoxPath to its executable.\n" + String(cause), { cause });
    }
  }

  private async connect(): Promise<void> {
    const endpoint = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Firefox did not expose WebDriver BiDi within 30s. ${this.stderr}`)), 30_000);
      // Keep draining stderr after startup so Firefox cannot block on a full pipe.
      void (async () => {
        const decoder = new TextDecoder();
        const reader = this.process.stderr.getReader();
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-16_384);
          const match = /WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(this.stderr);
          if (match) { clearTimeout(timer); resolve(`${match[1]}/session`); }
        }
        clearTimeout(timer);
        reject(new Error(`Firefox exited before connecting. ${this.stderr}`));
      })().catch(error => { clearTimeout(timer); reject(error); });
    });
    const socket = this.socket = new WebSocket(await endpoint);
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data));
        if (!message || typeof message !== "object") throw new Error("Invalid Firefox BiDi response");
        if (message.type === "event") {
          if (message.method === "log.entryAdded" && this.forwardConsole) this.console(message.params);
          return;
        }
        if (typeof message.id !== "number" || !["success", "error"].includes(message.type)) throw new Error("Invalid Firefox BiDi response");
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.type === "error") request.reject(new Error(`Firefox BiDi ${message.error}: ${message.message}`));
        else request.resolve(message.result);
      } catch (error) {
        this.disconnect(error instanceof Error ? error : new Error(String(error)));
      }
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Firefox BiDi connection timed out")), 30_000);
      socket.onclose = () => {
        clearTimeout(timer);
        const error = new Error("Firefox BiDi connection closed");
        this.disconnect(error);
        reject(error);
      };
      socket.onopen = () => { clearTimeout(timer); this.state = "open"; resolve(); };
      socket.onerror = () => {
        clearTimeout(timer);
        const error = new Error("Firefox BiDi connection failed");
        this.disconnect(error);
        reject(error);
      };
    });
  }

  private disconnect(error: Error): void {
    if (this.state === "open") {
      this.state = "disconnected";
      this.reportDisconnect(error);
    }
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private console(entry: any): void {
    // JavaScript errors are already tracked by the in-page runner.
    if (entry?.type !== "console") return;
    const type = entry.method === "warning" ? "warn" : entry.method;
    const fn = (console as any)[type];
    const args = Array.isArray(entry.args) ? entry.args : [];
    const values = args.map((arg: any) => arg.type === "error"
      ? { [Bun.inspect.custom]: () => `[${entry.text}]` }
      : remoteValue(arg));
    (typeof fn === "function" ? fn : console.log).apply(console, values.length ? values : [entry.text]);
  }

  private send(method: string, params: Record<string, unknown> = {}, timeout = 30_000): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Firefox BiDi connection closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Firefox BiDi ${method} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async navigate(url: string): Promise<void> {
    await this.send("browsingContext.navigate", { context: this.context, url, wait: "complete" });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("script.evaluate", {
      expression, target: { context: this.context }, awaitPromise: true,
      serializationOptions: { maxObjectDepth: null },
    });
    if (result.type === "exception") throw new Error(result.exceptionDetails?.text ?? "Firefox script evaluation failed");
    return remoteValue(result.result) as T;
  }

  async resize(width: number, height: number): Promise<void> {
    await this.send("browsingContext.setViewport", { context: this.context, viewport: { width, height }, devicePixelRatio: 1 });
  }

  async capture(options: {
    clip?: { x: number; y: number; width: number; height: number };
    type?: string; quality?: number; omitBackground?: boolean; fullPage?: boolean;
  }): Promise<string> {
    if (options.omitBackground) throw new Error("Firefox WebDriver BiDi does not support screenshot omitBackground.");
    const { data } = await this.send("browsingContext.captureScreenshot", {
      context: this.context,
      origin: options.fullPage || options.clip ? "document" : "viewport",
      format: { type: options.type === "jpeg" ? "image/jpeg" : "image/png", ...(options.quality != null ? { quality: options.quality / 100 } : {}) },
      ...(options.clip ? { clip: { type: "box", ...options.clip } } : {}),
    });
    if (typeof data !== "string") throw new Error("Firefox did not return screenshot data");
    return data;
  }

  async actions(type: "key" | "pointer" | "wheel", actions: Record<string, unknown>[]): Promise<void> {
    await this.send("input.performActions", {
      context: this.context,
      actions: [{ type, id: type, ...(type === "pointer" ? { parameters: { pointerType: "mouse" } } : {}), actions }],
    });
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";
    try {
      if (this.socket?.readyState === WebSocket.OPEN) await this.send("browser.close", {}, 2_000).catch(() => {});
      const timer = setTimeout(() => this.process.kill("SIGKILL"), 2_000);
      try { await this.process.exited; } finally { clearTimeout(timer); }
    } finally {
      this.socket?.close();
      this.disconnect(new Error("Firefox BiDi connection closed"));
      this.state = "closed";
      globalThis.process.removeListener("exit", this.onExit);
      await rm(this.profile, { recursive: true, force: true });
    }
  }
}

/** Deserialize the JSON-like values used by evaluation and console messages at the protocol boundary. */
function remoteValue(remote: any): unknown {
  if (!remote || typeof remote.type !== "string") throw new Error("Invalid Firefox BiDi remote value");
  switch (remote.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "string": case "boolean": return remote.value;
    case "number": return typeof remote.value === "number" ? remote.value : Number(remote.value);
    case "bigint": return BigInt(remote.value);
    case "array": case "set": return (remote.value ?? []).map(remoteValue);
    case "object": case "map": return Object.fromEntries((remote.value ?? []).map(([key, value]: [any, any]) => [typeof key === "string" ? key : String(remoteValue(key)), remoteValue(value)]));
    case "date": return new Date(remote.value);
    // Console can contain DOM nodes and functions; these are descriptions, not transferable objects.
    default: return `[${remote.type}]`;
  }
}

class FirefoxInput {
  readonly isIdle = false;
  private modifiers = new Set<Modifier>();
  private x = 0;
  private y = 0;
  constructor(private readonly view: FirefoxView) {}

  async keyDown(key: string): Promise<void> {
    key = resolveSmartModifier(key);
    await this.view.actions("key", [{ type: "keyDown", value: keyValue(key) }]);
    const modifier = key.replace(/Left$|Right$/, "") as Modifier;
    if (MODIFIERS.includes(modifier)) this.modifiers.add(modifier);
  }

  async keyUp(key: string): Promise<void> {
    key = resolveSmartModifier(key);
    await this.view.actions("key", [{ type: "keyUp", value: keyValue(key) }]);
    this.modifiers.delete(key.replace(/Left$|Right$/, "") as Modifier);
  }

  async press(key: string): Promise<void> {
    const tokens = key.split(/\+(?!$)/);
    for (const token of tokens) await this.keyDown(token);
    for (const token of tokens.reverse()) await this.keyUp(token);
  }

  async insertText(text: string): Promise<void> {
    if (!text) return;
    // BiDi has no text-insertion command. Use Gecko's editing command, which emits
    // a trusted input event without keyboard events and preserves selection/undo.
    await this.view.evaluate(`(() => {
      let doc = document;
      while (doc.activeElement?.tagName === "IFRAME") {
        const child = doc.activeElement.contentDocument;
        if (!child) break;
        doc = child;
      }
      return doc.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`);
  }

  async ensureModifiers(modifiers: string[]): Promise<Modifier[]> {
    const wanted = modifiers.map(resolveSmartModifier);
    for (const key of wanted) if (!MODIFIERS.includes(key as Modifier)) throw new Error(`Unknown modifier ${key}`);
    const previous = [...this.modifiers];
    for (const key of MODIFIERS) {
      if (wanted.includes(key) && !this.modifiers.has(key)) await this.keyDown(key);
      else if (!wanted.includes(key) && this.modifiers.has(key)) await this.keyUp(key);
    }
    return previous;
  }

  async click(x: number, y: number, options: { button?: Button; clickCount?: number } = {}): Promise<void> {
    const button = buttonValue(options.button ?? "left");
    this.x = x; this.y = y;
    const actions: Record<string, unknown>[] = [{ type: "pointerMove", x, y, duration: 0 }];
    for (let i = 0; i < (options.clickCount ?? 1); i++) actions.push({ type: "pointerDown", button }, { type: "pointerUp", button });
    await this.view.actions("pointer", actions);
  }

  async mouseMove(x: number, y: number, steps = 1): Promise<void> {
    const actions = Array.from({ length: steps }, (_, i) => ({
      type: "pointerMove", x: this.x + (x - this.x) * (i + 1) / steps,
      y: this.y + (y - this.y) * (i + 1) / steps, duration: 0,
    }));
    await this.view.actions("pointer", actions);
    this.x = x; this.y = y;
  }

  mouseDown(button: Button = "left"): Promise<void> { return this.view.actions("pointer", [{ type: "pointerDown", button: buttonValue(button) }]); }
  mouseUp(button: Button = "left"): Promise<void> { return this.view.actions("pointer", [{ type: "pointerUp", button: buttonValue(button) }]); }
  wheel(deltaX: number, deltaY: number): Promise<void> {
    return this.view.actions("wheel", [{ type: "scroll", x: Math.floor(this.x), y: Math.floor(this.y), deltaX: Math.round(deltaX), deltaY: Math.round(deltaY), duration: 0 }]);
  }
}

const MODIFIERS: Modifier[] = ["Alt", "Control", "Meta", "Shift"];
const buttonValue = (button: Button) => ({ left: 0, middle: 1, right: 2 })[button];
// WebDriver's standardized Unicode key values: https://www.w3.org/TR/webdriver2/#keyboard-actions
const SPECIAL_KEYS: Record<string, number> = {
  Cancel: 0xe001, Help: 0xe002, Backspace: 0xe003, Tab: 0xe004, Clear: 0xe005,
  Enter: 0xe006, NumpadEnter: 0xe007, Shift: 0xe008, ShiftLeft: 0xe008, Control: 0xe009, ControlLeft: 0xe009,
  Alt: 0xe00a, AltLeft: 0xe00a, Pause: 0xe00b, Escape: 0xe00c,
  PageUp: 0xe00e, PageDown: 0xe00f, End: 0xe010, Home: 0xe011,
  ArrowLeft: 0xe012, ArrowUp: 0xe013, ArrowRight: 0xe014, ArrowDown: 0xe015,
  Insert: 0xe016, Delete: 0xe017, NumpadEqual: 0xe019,
  NumpadMultiply: 0xe024, NumpadAdd: 0xe025, NumpadSubtract: 0xe027,
  NumpadDecimal: 0xe028, NumpadDivide: 0xe029, Meta: 0xe03d, MetaLeft: 0xe03d,
  ShiftRight: 0xe050, ControlRight: 0xe051, AltRight: 0xe052, MetaRight: 0xe053,
};
function keyValue(key: string): string {
  if (key === "\n" || key === "\r") key = "Enter";
  if (SPECIAL_KEYS[key]) return String.fromCodePoint(SPECIAL_KEYS[key]!);
  if (/^F([1-9]|1[0-2])$/.test(key)) return String.fromCodePoint(0xe030 + Number(key.slice(1)));
  if (/^Numpad\d$/.test(key)) return String.fromCodePoint(0xe01a + Number(key.slice(-1)));
  const value = USKeyboardLayout[key]?.key ?? key;
  if ([...value].length === 1) return value;
  throw new Error(`Key "${key}" is not supported by Firefox WebDriver BiDi`);
}
