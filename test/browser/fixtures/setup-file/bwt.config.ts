import { defineConfig } from "../../../../src/vitest/config";

export default defineConfig({
  setupFiles: ["./browser-setup.ts"],
  headless: false,
});
