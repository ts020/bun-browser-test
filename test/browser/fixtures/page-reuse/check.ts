import { expect, test } from "vitest";
import { cdp, page, server } from "vitest/browser";

let moduleRuns = 0;

export function checkDocument(label: string, mutate?: () => Promise<void>) {
  test(`fresh document: ${label}`, async () => {
    // The module, both Window objects, and tab-scoped storage must start clean.
    expect(++moduleRuns).toBe(1);
    expect((window as any).__bwt_leak__).toBeUndefined();
    expect((parent as any).__bwt_leak__).toBeUndefined();
    expect((window as any).__bwt_leaked_script__).toBeUndefined();
    expect((parent as any).__bwt_leaked_script__).toBeUndefined();
    expect(parent.name).toBe("");
    expect(sessionStorage.getItem("bwt-leak")).toBeNull();
    expect(document.querySelector("#bwt-leak")).toBeNull();
    expect(innerWidth).toBe(414);
    expect(innerHeight).toBe(896);
    expect(document.hasFocus()).toBe(true);
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
    if (server.browser === "chromium") expect(history.length).toBeLessThanOrEqual(2);

    // An interval installed in the previous top-level document must be gone.
    const lastTick = localStorage.getItem("bwt-tick");
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(localStorage.getItem("bwt-tick")).toBe(lastTick);

    (window as any).__bwt_leak__ = true;
    (parent as any).__bwt_leak__ = true;
    parent.name = "leaked";
    sessionStorage.setItem("bwt-leak", "leaked");
    document.body.innerHTML = '<div id="bwt-leak">leaked</div>';
    parent.history.replaceState({ leaked: true }, "", "#leaked");
    parent.setInterval(() => localStorage.setItem("bwt-tick", String(Date.now())), 5);
    await page.viewport(640, 480);
    if (server.browser === "chromium") await mutate?.();
  });
}

export async function installCdpState() {
  await cdp().send("Page.addScriptToEvaluateOnNewDocument", {
    source: "globalThis.__bwt_leaked_script__ = true",
  });
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
}
