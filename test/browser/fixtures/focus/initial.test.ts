import { expect, test } from "vitest";

// The first test must see a focused document without a click or a retry.
test("initial shadow focus applies CSS", () => {
  const host = document.createElement("div");
  document.body.append(host);
  try {
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<style>button { opacity: 1 } button:focus { opacity: .4 }</style><button>focus</button>';
    const button = root.querySelector("button")!;
    button.focus();
    expect(root.activeElement).toBe(button);
    expect(document.hasFocus()).toBe(true);
    expect(button.matches(":focus")).toBe(true);
    expect(getComputedStyle(button).opacity).toBe("0.4");
  } finally {
    host.remove();
  }
});
