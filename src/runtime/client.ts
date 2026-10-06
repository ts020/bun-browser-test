// ページ内で動くランタイム。Bun.build で IIFE にバンドルされ、
// window.__bwt として公開される。Bun 側からは invoke(name, args) だけを呼ぶ。

import type { ElementState, InspectResult, MarkResult, PageError, Step, TextMatch } from "../protocol";

declare global {
  interface Window {
    __bwt?: Runtime;
  }
}

interface Runtime {
  invoke(name: string, args: unknown[]): Promise<unknown>;
}

const errors: PageError[] = [];
window.addEventListener("error", (e: ErrorEvent) => {
  errors.push({ message: String(e.message), stack: e.error?.stack });
});
window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const r = e.reason;
  errors.push({ message: `Unhandled rejection: ${r?.message ?? String(r)}`, stack: r?.stack });
});

// ---- テキスト照合 ----

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

function matchText(m: TextMatch, raw: string): boolean {
  const s = normalize(raw);
  if (m.kind === "regex") return new RegExp(m.source, m.flags).test(s);
  if (m.exact) return s === m.value;
  return s.toLowerCase().includes(normalize(m.value).toLowerCase());
}

// ---- 可視性 ----

function isHiddenForA11y(el: Element): boolean {
  if (el.closest("[aria-hidden=true]")) return true;
  if ("checkVisibility" in el) return !el.checkVisibility({ visibilityProperty: true });
  for (let e: Element | null = el as Element; e; e = e.parentElement) {
    if (getComputedStyle(e).display === "none") return true;
  }
  return getComputedStyle(el).visibility === "hidden";
}

function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  if ("checkVisibility" in el && !el.checkVisibility({ visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// ---- ロールとアクセシブルネーム（よく使う範囲に絞った実装） ----

function implicitRole(el: Element): string | null {
  const tag = el.localName;
  switch (tag) {
    case "button":
      return "button";
    case "a":
    case "area":
      return el.hasAttribute("href") ? "link" : null;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "input": {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "hidden" || type === "password") return null;
      if (el.hasAttribute("list")) return "combobox";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    case "textarea":
      return "textbox";
    case "select":
      return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
    case "option":
      return "option";
    case "ul":
    case "ol":
    case "menu":
      return "list";
    case "li":
      return "listitem";
    case "img":
      return el.getAttribute("alt") === "" ? "presentation" : "img";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "aside":
      return "complementary";
    case "header":
      return el.closest("article,aside,main,nav,section") ? null : "banner";
    case "footer":
      return el.closest("article,aside,main,nav,section") ? null : "contentinfo";
    case "section":
      return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
    case "form":
      return "form";
    case "dialog":
      return "dialog";
    case "article":
      return "article";
    case "table":
      return "table";
    case "thead":
    case "tbody":
    case "tfoot":
      return "rowgroup";
    case "tr":
      return "row";
    case "td":
      return "cell";
    case "th":
      return "columnheader";
    case "p":
      return "paragraph";
    case "hr":
      return "separator";
    case "progress":
      return "progressbar";
    case "fieldset":
    case "details":
      return "group";
    case "summary":
      return "button";
    case "output":
      return "status";
    default:
      return null;
  }
}

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  return explicit || implicitRole(el);
}

const NAME_FROM_CONTENT = new Set([
  "button", "link", "heading", "checkbox", "radio", "option", "cell", "columnheader",
  "rowheader", "row", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
  "switch", "tooltip", "listitem",
]);

function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.getAttribute("aria-hidden") === "true") return "";
  if (["script", "style", "template", "noscript"].includes(node.localName)) return "";
  if (node.localName === "img") return node.getAttribute("alt") ?? "";
  const label = node.getAttribute("aria-label");
  if (label) return label;
  let out = "";
  for (const child of node.childNodes) out += textOf(child);
  return out;
}

function accessibleName(el: Element): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    return normalize(
      labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((e): e is HTMLElement => !!e)
        .map((e) => textOf(e))
        .join(" "),
    );
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return normalize(ariaLabel);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) {
      return normalize(el.value || (el.type === "submit" ? "Submit" : el.type === "reset" ? "Reset" : ""));
    }
    if (el instanceof HTMLInputElement && el.type === "image") return normalize(el.alt);
    const labels = el.labels ? [...el.labels].map((l) => textOf(l)).join(" ") : "";
    if (labels.trim()) return normalize(labels);
    return normalize(el.getAttribute("title") ?? el.getAttribute("placeholder") ?? "");
  }
  if (el.localName === "img") return normalize(el.getAttribute("alt") ?? el.getAttribute("title") ?? "");
  if (el.localName === "fieldset") {
    const legend = el.querySelector(":scope > legend");
    if (legend) return normalize(textOf(legend));
  }
  if (el.localName === "table") {
    const caption = el.querySelector(":scope > caption");
    if (caption) return normalize(textOf(caption));
  }
  if (el.localName === "figure") {
    const caption = el.querySelector(":scope > figcaption");
    if (caption) return normalize(textOf(caption));
  }
  const role = roleOf(el);
  if (role && NAME_FROM_CONTENT.has(role)) {
    const t = normalize(textOf(el));
    if (t) return t;
  }
  return normalize(el.getAttribute("title") ?? "");
}

function headingLevel(el: Element): number | undefined {
  const aria = el.getAttribute("aria-level");
  if (aria) return Number(aria);
  const m = /^h([1-6])$/.exec(el.localName);
  return m ? Number(m[1]) : undefined;
}

// ---- ロケーター解決 ----

type Scope = Document | Element;

function descendants(scope: Scope): Element[] {
  return [...scope.querySelectorAll("*")];
}

function labelText(el: Element): string[] {
  const out: string[] = [];
  if ("labels" in el && (el as HTMLInputElement).labels) {
    for (const l of (el as HTMLInputElement).labels!) out.push(textOf(l));
  }
  const al = el.getAttribute("aria-label");
  if (al) out.push(al);
  const lb = el.getAttribute("aria-labelledby");
  if (lb) {
    out.push(
      lb
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((e): e is HTMLElement => !!e)
        .map(textOf)
        .join(" "),
    );
  }
  return out;
}

function matchStep(scope: Scope, step: Step): Element[] {
  switch (step.type) {
    case "css":
      return [...scope.querySelectorAll(step.selector)];
    case "testId":
      return [...scope.querySelectorAll(`[data-testid="${CSS.escape(step.id)}"]`)];
    case "placeholder":
      return descendants(scope).filter((el) => {
        const p = el.getAttribute("placeholder");
        return p != null && matchText(step.text, p);
      });
    case "altText":
      return descendants(scope).filter((el) => {
        const a = el.getAttribute("alt");
        return a != null && matchText(step.text, a);
      });
    case "title":
      return descendants(scope).filter((el) => {
        const t = el.getAttribute("title");
        return t != null && matchText(step.text, t);
      });
    case "label":
      return descendants(scope).filter((el) => labelText(el).some((t) => matchText(step.text, t)));
    case "text": {
      const skip = new Set(["script", "style", "template", "noscript", "head", "title", "html"]);
      const hits = descendants(scope).filter(
        (el) => !skip.has(el.localName) && matchText(step.text, el.textContent ?? ""),
      );
      const set = new Set(hits);
      // 一番内側の要素だけを残す（子要素も一致するなら親は捨てる）
      return hits.filter((el) => ![...el.children].some((c) => set.has(c)));
    }
    case "role":
      return descendants(scope).filter((el) => {
        if (roleOf(el) !== step.role) return false;
        if (!step.includeHidden && isHiddenForA11y(el)) return false;
        if (step.level != null && headingLevel(el) !== step.level) return false;
        if (step.name && !matchText(step.name, accessibleName(el))) return false;
        return true;
      });
    default:
      throw new Error(`unexpected step ${(step as Step).type}`);
  }
}

function sortByDocumentOrder(els: Iterable<Element>): Element[] {
  return [...new Set(els)].sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

function resolve(steps: Step[], root: Scope = document): Element[] {
  let current: Scope[] = [root];
  for (const step of steps) {
    if (step.type === "nth") {
      const i = step.index < 0 ? current.length + step.index : step.index;
      current = current[i] ? [current[i]] : [];
      continue;
    }
    if (step.type === "filter") {
      current = current.filter((s) => {
        if (!(s instanceof Element)) return false;
        const text = s.textContent ?? "";
        if (step.hasText && !matchText(step.hasText, text)) return false;
        if (step.hasNotText && matchText(step.hasNotText, text)) return false;
        if (step.has && resolve(step.has, s).length === 0) return false;
        if (step.hasNot && resolve(step.hasNot, s).length > 0) return false;
        return true;
      });
      continue;
    }
    current = sortByDocumentOrder(current.flatMap((s) => matchStep(s, step)));
  }
  return current.filter((s): s is Element => s instanceof Element);
}

function preview(el: Element): string {
  const html = el.outerHTML.replace(/\s+/g, " ");
  return html.length > 200 ? `${html.slice(0, 200)}…` : html;
}

// ---- 要素の状態 ----

function valueOf(el: Element): string | string[] | null {
  if (el instanceof HTMLSelectElement) {
    return el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return null;
}

function checkedOf(el: Element): boolean | "mixed" | null {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    return el.indeterminate ? "mixed" : el.checked;
  }
  const aria = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed");
  if (aria === "mixed") return "mixed";
  if (aria === "true" || aria === "false") return aria === "true";
  return null;
}

function isDisabled(el: Element): boolean {
  return el.matches(":disabled") || !!el.closest("[aria-disabled=true]");
}

function stateOf(el: Element, styleProps: string[]): ElementState {
  const cs = getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const p of styleProps) styles[p] = cs.getPropertyValue(p);
  const attributes: Record<string, string> = {};
  for (const a of el.attributes) attributes[a.name] = a.value;
  return {
    tag: el.localName,
    preview: preview(el),
    visible: isVisible(el),
    text: normalize(el.textContent ?? ""),
    value: valueOf(el),
    checked: checkedOf(el),
    disabled: isDisabled(el),
    focused: document.activeElement === el,
    attributes,
    classes: [...el.classList],
    role: roleOf(el),
    name: accessibleName(el),
    styles,
  };
}

// ---- ページ側の操作 ----

let tokenSeq = 0;
const MARK = "data-bwt-target";

function strict(steps: Step[]): Element {
  const els = resolve(steps);
  if (els.length !== 1) throw new Error(`expected exactly one element, found ${els.length}`);
  return els[0]!;
}

const modules = new Map<string, Promise<Record<string, unknown>>>();
let cleanup: (() => unknown) | null = null;

function loadCss(href: string): Promise<void> {
  if (document.querySelector(`link[data-bwt-css="${CSS.escape(href)}"]`)) return Promise.resolve();
  return new Promise((ok, ng) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.bwtCss = href;
    link.onload = () => ok();
    link.onerror = () => ng(new Error(`failed to load ${href}`));
    document.head.append(link);
  });
}

async function importModule(url: string, css: string[]) {
  await Promise.all(css.map(loadCss));
  let p = modules.get(url);
  if (!p) modules.set(url, (p = import(/* @vite-ignore */ url)));
  return p;
}

const handlers: Record<string, (...args: any[]) => unknown> = {
  count: (steps: Step[]) => resolve(steps).length,

  inspect(steps: Step[], styleProps: string[] = []): InspectResult {
    const els = resolve(steps);
    return {
      count: els.length,
      previews: els.slice(0, 5).map(preview),
      element: els.length === 1 ? stateOf(els[0]!, styleProps) : null,
    };
  },

  all: (steps: Step[]) =>
    resolve(steps).map((el) => ({ text: normalize(el.textContent ?? ""), visible: isVisible(el) })),

  mark(steps: Step[]): MarkResult {
    const els = resolve(steps);
    if (els.length !== 1) return { count: els.length, previews: els.slice(0, 5).map(preview) };
    const token = `t${++tokenSeq}`;
    els[0]!.setAttribute(MARK, token);
    return { count: 1, token, selector: `[${MARK}="${token}"]` };
  },

  unmark(token: string) {
    document.querySelector(`[${MARK}="${token}"]`)?.removeAttribute(MARK);
  },

  isVisible: (steps: Step[]) => {
    const els = resolve(steps);
    return els.length > 0 && isVisible(els[0]!);
  },

  focus(steps: Step[]) {
    (strict(steps) as HTMLElement).focus();
  },

  selectAll(steps: Step[]) {
    const el = strict(steps) as HTMLElement;
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.select();
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      throw new Error(`element is not editable: ${preview(el)}`);
    }
  },

  selectOptions(steps: Step[], values: string[]) {
    const el = strict(steps);
    if (!(el instanceof HTMLSelectElement)) throw new Error(`element is not a <select>: ${preview(el)}`);
    const picked: string[] = [];
    for (const opt of el.options) {
      const hit = values.includes(opt.value) || values.includes(normalize(opt.label));
      if (hit && !el.multiple && picked.length > 0) continue;
      opt.selected = hit;
      if (hit) picked.push(opt.value);
    }
    if (picked.length === 0) throw new Error(`no option matched ${JSON.stringify(values)}`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return picked;
  },

  center(steps: Step[]) {
    const el = strict(steps);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },

  getAttribute: (steps: Step[], name: string) => strict(steps).getAttribute(name),
  innerHTML: (steps: Step[]) => strict(steps).innerHTML,

  errors: () => errors.splice(0),

  async mount(url: string, css: string[], props: unknown) {
    const mod = await importModule(url, css);
    const fn = mod.default;
    if (typeof fn !== "function") throw new Error(`${url} has no default export function`);
    if (cleanup) await cleanup();
    cleanup = null;
    let root = document.getElementById("root");
    if (!root) {
      root = document.createElement("div");
      root.id = "root";
      document.body.append(root);
    }
    root.replaceChildren();
    const ret = await fn(root, props);
    if (typeof ret === "function") cleanup = ret as () => unknown;
  },

  async call(url: string, css: string[], name: string, args: unknown[]) {
    const mod = await importModule(url, css);
    const fn = mod[name];
    if (typeof fn !== "function") throw new Error(`export "${name}" of ${url} is not a function`);
    return fn(...args);
  },
};

window.__bwt = {
  async invoke(name, args) {
    const h = handlers[name];
    if (!h) throw new Error(`unknown runtime call: ${name}`);
    return h(...args);
  },
};
