import type { MarkResult, Step, TextMatch } from "./protocol";
import { getSession, type BrowserSession } from "./session";

export type TextInput = string | RegExp;

export function toTextMatch(t: TextInput, exact?: boolean): TextMatch {
  return t instanceof RegExp ? { kind: "regex", source: t.source, flags: t.flags } : { kind: "string", value: t, exact };
}

export interface TextOptions {
  /** true なら空白を正規化したうえで完全一致。既定は大文字小文字を無視した部分一致。 */
  exact?: boolean;
}

export interface RoleOptions extends TextOptions {
  name?: TextInput;
  level?: number;
  includeHidden?: boolean;
}

export interface FilterOptions {
  hasText?: TextInput;
  hasNotText?: TextInput;
  has?: Locator;
  hasNot?: Locator;
}

export interface ActionOptions {
  timeout?: number;
}

export type Modifier = "Shift" | "Control" | "Alt" | "Meta";

export interface ClickOptions extends ActionOptions {
  button?: "left" | "right" | "middle";
  modifiers?: Modifier[];
  clickCount?: 1 | 2 | 3;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeText(t: TextInput): string {
  return t instanceof RegExp ? String(t) : JSON.stringify(t);
}

export class StrictModeError extends Error {}

/** getBy* / locator を持つものの共通部分。page もこれを継承する。 */
export abstract class Queryable {
  protected abstract readonly steps: Step[];
  protected abstract readonly label: string;

  protected child(step: Step, label: string): Locator {
    return new Locator([...this.steps, step], this.label ? `${this.label}.${label}` : label);
  }

  locator(selector: string): Locator {
    return this.child({ type: "css", selector }, `locator(${JSON.stringify(selector)})`);
  }

  getByRole(role: string, options: RoleOptions = {}): Locator {
    const { name, exact, level, includeHidden } = options;
    const opts = [name != null && `name: ${describeText(name)}`, level != null && `level: ${level}`].filter(Boolean);
    return this.child(
      { type: "role", role, name: name != null ? toTextMatch(name, exact) : undefined, level, includeHidden },
      `getByRole(${JSON.stringify(role)}${opts.length ? `, { ${opts.join(", ")} }` : ""})`,
    );
  }

  getByText(text: TextInput, options: TextOptions = {}): Locator {
    return this.child({ type: "text", text: toTextMatch(text, options.exact) }, `getByText(${describeText(text)})`);
  }

  getByLabelText(text: TextInput, options: TextOptions = {}): Locator {
    return this.child({ type: "label", text: toTextMatch(text, options.exact) }, `getByLabelText(${describeText(text)})`);
  }

  getByPlaceholder(text: TextInput, options: TextOptions = {}): Locator {
    return this.child(
      { type: "placeholder", text: toTextMatch(text, options.exact) },
      `getByPlaceholder(${describeText(text)})`,
    );
  }

  getByAltText(text: TextInput, options: TextOptions = {}): Locator {
    return this.child({ type: "altText", text: toTextMatch(text, options.exact) }, `getByAltText(${describeText(text)})`);
  }

  getByTitle(text: TextInput, options: TextOptions = {}): Locator {
    return this.child({ type: "title", text: toTextMatch(text, options.exact) }, `getByTitle(${describeText(text)})`);
  }

  getByTestId(id: string): Locator {
    return this.child({ type: "testId", id }, `getByTestId(${JSON.stringify(id)})`);
  }
}

/**
 * ページ内の要素を指す遅延評価の参照。中身は JSON にできる step の列で、
 * 操作やアサーションのたびにページ側で解決し直す。
 */
export class Locator extends Queryable {
  readonly steps: Step[];
  protected readonly label: string;

  constructor(steps: Step[], label: string) {
    super();
    this.steps = steps;
    this.label = label;
  }

  toString(): string {
    return this.label;
  }

  nth(index: number): Locator {
    return this.child({ type: "nth", index }, `nth(${index})`);
  }

  first(): Locator {
    return this.child({ type: "nth", index: 0 }, "first()");
  }

  last(): Locator {
    return this.child({ type: "nth", index: -1 }, "last()");
  }

  filter(options: FilterOptions): Locator {
    const { hasText, hasNotText, has, hasNot } = options;
    return this.child(
      {
        type: "filter",
        hasText: hasText != null ? toTextMatch(hasText) : undefined,
        hasNotText: hasNotText != null ? toTextMatch(hasNotText) : undefined,
        has: has?.steps,
        hasNot: hasNot?.steps,
      },
      "filter(…)",
    );
  }

  // ---- 読み取り ----

  async count(): Promise<number> {
    return (await getSession()).invoke<number>("count", [this.steps]);
  }

  /** 一致する要素それぞれを指す Locator の配列。 */
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  async allTextContents(): Promise<string[]> {
    const items = await (await getSession()).invoke<{ text: string }[]>("all", [this.steps]);
    return items.map((i) => i.text);
  }

  async isVisible(): Promise<boolean> {
    return (await getSession()).invoke<boolean>("isVisible", [this.steps]);
  }

  async textContent(options?: ActionOptions): Promise<string> {
    return this.withElement(options, async (s) => {
      const r = await s.invoke<{ element: { text: string } }>("inspect", [this.steps]);
      return r.element.text;
    });
  }

  async innerHTML(options?: ActionOptions): Promise<string> {
    return this.withElement(options, (s) => s.invoke<string>("innerHTML", [this.steps]));
  }

  async getAttribute(name: string, options?: ActionOptions): Promise<string | null> {
    return this.withElement(options, (s) => s.invoke<string | null>("getAttribute", [this.steps, name]));
  }

  async inputValue(options?: ActionOptions): Promise<string> {
    return this.withElement(options, async (s) => {
      const r = await s.invoke<{ element: { value: string | null } }>("inspect", [this.steps]);
      return String(r.element.value ?? "");
    });
  }

  // ---- 操作（すべてネイティブ入力。isTrusted: true のイベントになる） ----

  async click(options: ClickOptions = {}): Promise<void> {
    const { timeout, ...rest } = options;
    await this.withMarked(timeout, (s, selector, remaining) =>
      s.run((v) => v.click(selector, { ...rest, timeout: remaining })),
    );
  }

  dblclick(options: ClickOptions = {}): Promise<void> {
    return this.click({ ...options, clickCount: 2 });
  }

  tripleClick(options: ClickOptions = {}): Promise<void> {
    return this.click({ ...options, clickCount: 3 });
  }

  /** 中身を消してから text を入力する。 */
  async fill(text: string, options?: ActionOptions): Promise<void> {
    await this.withElement(options, async (s) => {
      await s.invoke("selectAll", [this.steps]);
      if (text === "") await s.run((v) => v.press("Backspace"));
      else await s.run((v) => v.type(text));
    });
  }

  clear(options?: ActionOptions): Promise<void> {
    return this.fill("", options);
  }

  /** クリックしてフォーカスを当て、カーソル位置に text を入力する。 */
  async type(text: string, options?: ClickOptions): Promise<void> {
    await this.click(options);
    const s = await getSession();
    await s.run((v) => v.type(text));
  }

  async press(key: string, options: ActionOptions & { modifiers?: Modifier[] } = {}): Promise<void> {
    await this.withElement(options, async (s) => {
      await s.invoke("focus", [this.steps]);
      await s.run((v) => v.press(key, { modifiers: options.modifiers }));
    });
  }

  async focus(options?: ActionOptions): Promise<void> {
    await this.withElement(options, (s) => s.invoke("focus", [this.steps]));
  }

  async check(options?: ActionOptions): Promise<void> {
    if (!(await this.isChecked(options))) await this.click(options);
  }

  async uncheck(options?: ActionOptions): Promise<void> {
    if (await this.isChecked(options)) await this.click(options);
  }

  private async isChecked(options?: ActionOptions): Promise<boolean> {
    return this.withElement(options, async (s) => {
      const r = await s.invoke<{ element: { checked: boolean | "mixed" | null } }>("inspect", [this.steps]);
      return r.element.checked === true;
    });
  }

  async selectOptions(values: string | string[], options?: ActionOptions): Promise<string[]> {
    const list = Array.isArray(values) ? values : [values];
    return this.withElement(options, (s) => s.invoke<string[]>("selectOptions", [this.steps, list]));
  }

  async scrollIntoView(options?: ActionOptions): Promise<void> {
    await this.withMarked(options?.timeout, (s, selector, remaining) =>
      s.run((v) => v.scrollTo(selector, { timeout: remaining })),
    );
  }

  /** マウスを要素の中心へ動かす。Chrome バックエンドのみ（CDP で mouseMoved を送る）。 */
  async hover(options?: ActionOptions): Promise<void> {
    await this.withElement(options, async (s) => {
      if (s.config.backend !== "chrome") throw new Error("hover() is only supported on the chrome backend");
      const { x, y } = await s.invoke<{ x: number; y: number }>("center", [this.steps]);
      await s.run((v) => v.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }));
    });
  }

  // ---- 内部 ----

  /** 要素がちょうど 1 つ見つかるまで待つ。0 個ならリトライ、2 個以上なら即エラー。 */
  private async waitForOne(timeout: number): Promise<{ session: BrowserSession; deadline: number }> {
    const session = await getSession();
    const deadline = Date.now() + timeout;
    for (;;) {
      const n = await session.invoke<number>("count", [this.steps]);
      if (n === 1) return { session, deadline };
      if (n > 1) throw await this.strictError(session);
      if (Date.now() >= deadline) {
        throw new Error(`Locator ${this.label}: no element found within ${timeout}ms`);
      }
      await sleep(30);
    }
  }

  private async strictError(session: BrowserSession): Promise<StrictModeError> {
    const r = await session.invoke<{ count: number; previews: string[] }>("inspect", [this.steps]);
    return new StrictModeError(
      `Locator ${this.label}: strict mode violation, resolved to ${r.count} elements:\n` +
        r.previews.map((p) => `  - ${p}`).join("\n"),
    );
  }

  private async withElement<T>(options: ActionOptions | undefined, fn: (s: BrowserSession) => Promise<T>): Promise<T> {
    const timeout = options?.timeout ?? (await getSession()).config.actionTimeout;
    const { session } = await this.waitForOne(timeout);
    return fn(session);
  }

  /**
   * 要素に一時的な属性を付けて CSS セレクタで指せるようにし、
   * Bun.WebView のネイティブ操作（actionability 待ち付き）に渡す。
   */
  private async withMarked(
    timeout: number | undefined,
    fn: (s: BrowserSession, selector: string, remaining: number) => Promise<void>,
  ): Promise<void> {
    const t = timeout ?? (await getSession()).config.actionTimeout;
    const { session, deadline } = await this.waitForOne(t);
    const mark = await session.invoke<MarkResult>("mark", [this.steps]);
    if (mark.count !== 1 || !("token" in mark)) throw await this.strictError(session);
    try {
      await fn(session, mark.selector, Math.max(deadline - Date.now(), 100));
    } catch (e) {
      throw new Error(`Locator ${this.label}: ${(e as Error).message}`, { cause: e });
    } finally {
      // クリックで遷移した場合などは失敗してよい
      await session.invoke("unmark", [mark.token]).catch(() => {});
    }
  }
}
