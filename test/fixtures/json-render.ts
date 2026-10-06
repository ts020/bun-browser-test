// JSON から HTML を作る小さなレンダラー（テスト用のサンプル）。
// 文字列を返す renderToString は Bun でもブラウザでも動き、
// DOM に直接描く default export は page.mount から使う。
import "./json-render.css";

export type Node =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "text"; text: string; tone?: "muted" | "danger" }
  | { type: "list"; items: string[] }
  | { type: "button"; label: string; action: "increment" | "toggle" }
  | { type: "input"; label: string; name: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderToString(nodes: Node[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "heading":
          return `<h${n.level}>${esc(n.text)}</h${n.level}>`;
        case "text":
          return `<p class="text ${n.tone ?? ""}">${esc(n.text)}</p>`;
        case "list":
          return `<ul>${n.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
        case "button":
          return `<button type="button" data-action="${n.action}">${esc(n.label)}</button>`;
        case "input":
          return `<label>${esc(n.label)} <input name="${esc(n.name)}"></label>`;
      }
    })
    .join("\n");
}

export function measure(selector: string) {
  const r = document.querySelector(selector)!.getBoundingClientRect();
  return { width: r.width, height: r.height };
}

export default function mount(root: HTMLElement, props: { nodes: Node[] }) {
  root.innerHTML = renderToString(props.nodes);
  let count = 0;
  const output = document.createElement("output");
  output.textContent = "count: 0";
  root.append(output);
  const onClick = (e: MouseEvent) => {
    const btn = (e.target as Element).closest("button");
    if (!btn || !e.isTrusted) return;
    if (btn.dataset.action === "increment") output.textContent = `count: ${++count}`;
    if (btn.dataset.action === "toggle") root.querySelector("ul")?.toggleAttribute("hidden");
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}
