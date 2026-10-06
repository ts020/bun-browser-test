import { defineConfig } from "../../../../src/vitest/config";

export default defineConfig({
  commands: {
    async installLeakingScript({ view }) {
      await view.cdp("Page.addScriptToEvaluateOnNewDocument", {
        source: "globalThis.__bwt_leaked_script__ = true",
      });
    },
  },
});
