import { defineConfig } from "../../../../src/vitest/config";

// 動作にかかる時間に、ファイル名に書いた遅れを足してから失敗する。
// 動作の結果がタスクの猶予の内か外かに届くようにするため。
const slowScreenshot = (_context: unknown, name: string, options: { timeout: number }) => {
  const delay = Number(/delay-(\d+)/.exec(name)?.[1] ?? 0);
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`slow screenshot after ${delay}ms`)), options.timeout + delay);
    timer.unref?.();
  });
};

export default defineConfig({
  screenshotFailures: false,
  commands: {
    __vitest_screenshot: slowScreenshot,
  },
});
