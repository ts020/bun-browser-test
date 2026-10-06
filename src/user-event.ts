import type { ClickOptions, Locator, Modifier } from "./locator";
import { getSession } from "./session";

const MODIFIERS = new Set<string>(["Shift", "Control", "Alt", "Meta"]);

/**
 * `"hello{Enter}"` や `"{Control+a}{Backspace}"` のような文字列を、
 * 文字の入力とキー押下の列に分解する。`{{` は `{` そのもの。
 */
export function parseKeyboard(input: string): ({ text: string } | { key: string; modifiers: Modifier[] })[] {
  const out: ({ text: string } | { key: string; modifiers: Modifier[] })[] = [];
  let buf = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "{" && input[i + 1] === "{") {
      buf += "{";
      i++;
      continue;
    }
    if (ch !== "{") {
      buf += ch;
      continue;
    }
    const end = input.indexOf("}", i);
    if (end < 0) throw new Error(`unterminated "{" in keyboard input: ${input}`);
    if (buf) out.push({ text: buf });
    buf = "";
    const parts = input.slice(i + 1, end).split("+");
    const key = parts.pop()!;
    for (const m of parts) if (!MODIFIERS.has(m)) throw new Error(`unknown modifier "${m}" in ${input}`);
    out.push({ key, modifiers: parts as Modifier[] });
    i = end;
  }
  if (buf) out.push({ text: buf });
  return out;
}

/** vitest の userEvent に寄せた薄いラッパー。中身は Locator のメソッドと Bun.WebView のネイティブ入力。 */
export const userEvent = {
  click: (el: Locator, options?: ClickOptions) => el.click(options),
  dblClick: (el: Locator, options?: ClickOptions) => el.dblclick(options),
  tripleClick: (el: Locator, options?: ClickOptions) => el.tripleClick(options),
  fill: (el: Locator, text: string) => el.fill(text),
  clear: (el: Locator) => el.clear(),
  hover: (el: Locator) => el.hover(),
  selectOptions: (el: Locator, values: string | string[]) => el.selectOptions(values),

  /** 要素をクリックしてから keyboard() と同じ書式で入力する。 */
  async type(el: Locator, text: string) {
    await el.click();
    await userEvent.keyboard(text);
  },

  /** フォーカス中の要素へ入力する。`{Enter}` `{Shift+Tab}` などのキー指定が使える。 */
  async keyboard(text: string) {
    const s = await getSession();
    for (const part of parseKeyboard(text)) {
      if ("text" in part) await s.run((v) => v.type(part.text));
      else await s.run((v) => v.press(part.key, { modifiers: part.modifiers }));
    }
  },

  tab: (options: { shift?: boolean } = {}) => userEvent.keyboard(options.shift ? "{Shift+Tab}" : "{Tab}"),
};
