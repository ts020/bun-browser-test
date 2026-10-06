import { defineConfig } from "../../../../src/vitest/config";

// vitest では test/browser/package.json の "link:./bundled-lib" で解決している依存
export default defineConfig({
  alias: {
    "@vitest/bundled-lib": "../../bundled-lib",
  },
  optimizeDeps: {
    include: ["@vitest/bundled-lib"],
  },
});
