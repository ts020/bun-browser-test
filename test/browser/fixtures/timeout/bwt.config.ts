import { defineConfig } from "../../../../src/vitest/config";

export default defineConfig({
  actionTimeout: 500,
  expect: {
    poll: {
      timeout: 500,
    },
  },
});
