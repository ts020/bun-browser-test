import { Locator, type TextInput } from "./locator";
import type { ElementState, InspectResult } from "./protocol";
import { getSession } from "./session";

export interface ExpectElementOptions {
  /** リトライし続ける時間 (ms)。既定は configure({ expectTimeout })。 */
  timeout?: number;
  interval?: number;
}

/**
 * expect.element(locator) が返すアサーション。どれも Promise なので必ず await すること。
 * 条件を満たすまでタイムアウトまでリトライする。
 */
export interface ElementAssertions {
  readonly not: ElementAssertions;
  toBeInTheDocument(): Promise<void>;
  toBeVisible(): Promise<void>;
  toBeHidden(): Promise<void>;
  toHaveTextContent(text: TextInput): Promise<void>;
  toHaveValue(value: string | string[] | number): Promise<void>;
  toHaveAttribute(name: string, value?: TextInput): Promise<void>;
  toHaveClass(...names: string[]): Promise<void>;
  /** getComputedStyle の値と比べる。プロパティ名は CSS 表記（kebab-case）。 */
  toHaveStyle(styles: Record<string, string>): Promise<void>;
  toBeChecked(): Promise<void>;
  toBePartiallyChecked(): Promise<void>;
  toBeDisabled(): Promise<void>;
  toBeEnabled(): Promise<void>;
  toBeFocused(): Promise<void>;
  toHaveAccessibleName(name: TextInput): Promise<void>;
  toHaveRole(role: string): Promise<void>;
  toHaveCount(count: number): Promise<void>;
}

type Check = (r: InspectResult) => { pass: boolean; expected: string; received: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function textMatches(expected: TextInput, actual: string, exact = false): boolean {
  if (expected instanceof RegExp) return new RegExp(expected.source, expected.flags).test(actual);
  return exact ? norm(actual) === norm(expected) : norm(actual).includes(norm(expected));
}

const show = (v: unknown) => (v instanceof RegExp ? String(v) : JSON.stringify(v));

/** 要素 1 つについてのチェックを作る。0 個なら不合格、2 個以上は strict mode 違反。 */
function onElement(expected: string, test: (e: ElementState) => { pass: boolean; received: string }): Check {
  return (r) => {
    if (!r.element) return { pass: false, expected, received: "<no element>" };
    return { expected, ...test(r.element) };
  };
}

function assertions(locator: Locator, options: ExpectElementOptions, negated: boolean): ElementAssertions {
  async function run(matcher: string, check: Check, styleProps: string[] = [], allowMany = false): Promise<void> {
    // 呼び出し元のスタックを残すため、Error は先に作っておく
    const error = new Error();
    const s = await getSession();
    const timeout = options.timeout ?? s.config.expectTimeout;
    const interval = options.interval ?? 30;
    const deadline = Date.now() + timeout;
    let last: InspectResult;
    let result: ReturnType<Check>;
    for (;;) {
      last = await s.invoke<InspectResult>("inspect", [locator.steps, styleProps]);
      if (last.count > 1 && !allowMany) {
        error.message =
          `expect.element(${locator}).${matcher}: strict mode violation, resolved to ${last.count} elements:\n` +
          last.previews.map((p) => `  - ${p}`).join("\n");
        throw error;
      }
      result = check(last);
      if (result.pass !== negated) return;
      if (Date.now() >= deadline) break;
      await sleep(interval);
    }
    const lines = [
      `expect.element(${locator})${negated ? ".not" : ""}.${matcher} failed after ${timeout}ms`,
      "",
      `Expected: ${negated ? "not " : ""}${result.expected}`,
      `Received: ${result.received}`,
    ];
    if (last.element) lines.push("", `Element: ${last.element.preview}`);
    error.message = lines.join("\n");
    throw error;
  }

  const api: ElementAssertions = {
    get not() {
      return assertions(locator, options, !negated);
    },
    toBeInTheDocument: () =>
      run("toBeInTheDocument()", (r) => ({
        pass: r.count > 0,
        expected: "element in the document",
        received: `${r.count} element(s)`,
      })),
    toBeVisible: () =>
      run(
        "toBeVisible()",
        onElement("visible", (e) => ({ pass: e.visible, received: e.visible ? "visible" : "hidden" })),
      ),
    toBeHidden: () =>
      run("toBeHidden()", (r) => ({
        pass: !r.element || !r.element.visible,
        expected: "hidden or not present",
        received: r.element ? (r.element.visible ? "visible" : "hidden") : "<no element>",
      })),
    toHaveTextContent: (text) =>
      run(
        `toHaveTextContent(${show(text)})`,
        onElement(`text matching ${show(text)}`, (e) => ({ pass: textMatches(text, e.text), received: show(e.text) })),
      ),
    toHaveValue: (value) =>
      run(
        `toHaveValue(${show(value)})`,
        onElement(`value ${show(value)}`, (e) => ({
          pass: JSON.stringify(typeof value === "number" ? String(value) : value) === JSON.stringify(e.value),
          received: show(e.value),
        })),
      ),
    toHaveAttribute: (name, value) =>
      run(
        `toHaveAttribute(${show(name)}${value !== undefined ? `, ${show(value)}` : ""})`,
        onElement(value === undefined ? `attribute ${name}` : `attribute ${name}=${show(value)}`, (e) => {
          const actual = e.attributes[name];
          const pass = actual !== undefined && (value === undefined || textMatches(value, actual, true));
          return { pass, received: actual === undefined ? `no attribute ${name}` : `${name}=${show(actual)}` };
        }),
      ),
    toHaveClass: (...names) =>
      run(
        `toHaveClass(${names.map(show).join(", ")})`,
        onElement(`class ${names.join(" ")}`, (e) => ({
          pass: names.every((n) => e.classes.includes(n)),
          received: show(e.classes.join(" ")),
        })),
      ),
    toHaveStyle: (styles) => {
      const props = Object.keys(styles);
      return run(
        `toHaveStyle(${show(styles)})`,
        onElement(show(styles), (e) => ({
          pass: props.every((p) => norm(e.styles[p] ?? "") === norm(styles[p]!)),
          received: show(e.styles),
        })),
        props,
      );
    },
    toBeChecked: () =>
      run(
        "toBeChecked()",
        onElement("checked", (e) => ({ pass: e.checked === true, received: `checked=${show(e.checked)}` })),
      ),
    toBePartiallyChecked: () =>
      run(
        "toBePartiallyChecked()",
        onElement("mixed", (e) => ({ pass: e.checked === "mixed", received: `checked=${show(e.checked)}` })),
      ),
    toBeDisabled: () =>
      run(
        "toBeDisabled()",
        onElement("disabled", (e) => ({ pass: e.disabled, received: e.disabled ? "disabled" : "enabled" })),
      ),
    toBeEnabled: () =>
      run(
        "toBeEnabled()",
        onElement("enabled", (e) => ({ pass: !e.disabled, received: e.disabled ? "disabled" : "enabled" })),
      ),
    toBeFocused: () =>
      run(
        "toBeFocused()",
        onElement("focused", (e) => ({ pass: e.focused, received: e.focused ? "focused" : "not focused" })),
      ),
    toHaveAccessibleName: (name) =>
      run(
        `toHaveAccessibleName(${show(name)})`,
        onElement(`name ${show(name)}`, (e) => ({ pass: textMatches(name, e.name, true), received: show(e.name) })),
      ),
    toHaveRole: (role) =>
      run(
        `toHaveRole(${show(role)})`,
        onElement(`role ${show(role)}`, (e) => ({ pass: e.role === role, received: show(e.role) })),
      ),
    toHaveCount: (count) =>
      run(
        `toHaveCount(${count})`,
        (r) => ({ pass: r.count === count, expected: `${count} element(s)`, received: `${r.count} element(s)` }),
        [],
        true,
      ),
  };
  return api;
}

export function expectElement(locator: Locator, options: ExpectElementOptions = {}): ElementAssertions {
  if (!(locator instanceof Locator)) throw new TypeError("expect.element() expects a Locator");
  return assertions(locator, options, false);
}
