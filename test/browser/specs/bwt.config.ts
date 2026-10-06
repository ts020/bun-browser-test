import { defineConfig } from "../../../src/vitest/config";

// ここのスペックはブラウザではなく Bun で動かし、fixtures を別の bun test として起動して結果を確かめる
// （vitest の test/browser/specs と同じ役割）
export default defineConfig({
  include: () => false,
});
