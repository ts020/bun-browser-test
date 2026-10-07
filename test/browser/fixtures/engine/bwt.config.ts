import { defineConfig } from "../../../../src/vitest/config";
import { resolveBackend } from "../../../../src/config";

export default defineConfig({
  commands: {
    selectedBackend: () => process.env.BWT_EXPECT_BACKEND || resolveBackend(),
    rawView: ({ view }) => view.url,
  },
});
