import { expect, test } from "vitest";
import { cdp, page, server, userEvent } from "vitest/browser";

let moduleRuns = 0;

export function checkEngine(label: string) {
  test(`engine and isolation: ${label}`, async () => {
    const selected = await server.commands.selectedBackend();
    expect(server.browser).toBe(selected === "chrome" ? "chromium" : selected);
    if (server.browser === "firefox") expect(navigator.userAgent).toMatch(/Gecko\/.*Firefox\//);
    if (server.browser === "chromium") expect(navigator.userAgent).toMatch(/(?:HeadlessChrome|Chrome)\//);
    expect(++moduleRuns).toBe(1);
    expect((window as any).__engineLeak).toBeUndefined();
    expect((parent as any).__engineLeak).toBeUndefined();
    expect(document.querySelector("#leak")).toBeNull();
    expect(sessionStorage.getItem("engine-leak")).toBeNull();
    expect(customElements.get("engine-element")).toBeUndefined();
    expect(innerWidth).toBe(414);
    if (server.browser === "firefox") {
      expect(localStorage.getItem("engine-leak")).toBeNull();
      expect(document.cookie).not.toContain("engine-leak");
      localStorage.setItem("engine-leak", "yes");
      document.cookie = "engine-leak=yes; path=/";
    }

    const events: string[] = [];
    customElements.define("engine-element", class extends HTMLElement {
      connectedCallback() { events.push("connected"); }
      disconnectedCallback() { events.push("disconnected"); }
    });
    const element = document.createElement("engine-element");
    document.body.append(element);
    element.remove();
    expect(events).toEqual(["connected", "disconnected"]);

    document.body.innerHTML = '<div id="leak" style="width:40px;overflow-wrap:anywhere;transition:opacity 0.01s linear">abcdefghijklmnopqrstuvwxyz</div><input aria-label="text"><button>Click</button>';
    const box = document.querySelector<HTMLElement>("#leak")!;
    const style = getComputedStyle(box);
    expect(style.transitionProperty).toBe("opacity");
    expect(style.transitionDuration).toBe("0.01s");
    expect(box.getBoundingClientRect().height).toBeGreaterThan(20);
    expect(CSS.supports("animation-timeline", "scroll()")).toBe(typeof (window as any).ScrollTimeline === "function");
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date("2024-02-29T12:00:00Z"))).toBe("29/02/2024");

    let trusted = false;
    document.querySelector("button")!.addEventListener("click", e => { trusted = e.isTrusted; });
    await userEvent.type(page.getByRole("textbox"), "Gecko 日本語");
    await expect.element(page.getByRole("textbox")).toHaveValue("Gecko 日本語");
    await page.getByRole("button").click();
    expect(trusted).toBe(true);
    await page.viewport(640, 480);
    expect(innerWidth).toBe(640);
    if (server.browser === "firefox") {
      expect(() => cdp().send("Runtime.enable")).toThrow(/CDP.*not supported.*firefox/);
      expect(() => cdp().on("Runtime.consoleAPICalled", () => {})).toThrow(/CDP.*not supported.*firefox/);
      await expect(userEvent.dragAndDrop(page.getByRole("button"), page.getByRole("textbox"))).rejects.toThrow(/drag and drop is not supported/);
      await expect(server.commands.rawView()).rejects.toThrow(/raw Bun.WebView.*not supported.*firefox/);
    }
    (window as any).__engineLeak = true;
    (parent as any).__engineLeak = true;
    sessionStorage.setItem("engine-leak", "yes");
  });
}
