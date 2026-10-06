// vitest の fixtures/expect-dom/vitest.config.js を移植したもの
import { defineConfig } from "../../../../src/vitest/config";

export default defineConfig({
  setupFiles: ["./setup.ts"],
  toMatchScreenshot: {
    comparators: {
      failing: () => ({ pass: false, diff: null, message: null }),
    },
  },
});
