// `vitest/browser`（と旧名の `@vitest/browser/context`）の中身。
// vitest 本体では Vite の仮想モジュールとして生成されるものを、同じ形で用意する。
// @ts-ignore 配布物を直接読み込む（bwt:* は Bun.build のプラグインで解決する）
import { cdp, createUserEvent, locators, page, utils } from "bwt:browser-context";
import { boot } from "./boot";

const runner = (globalThis as any).__vitest_browser_runner__;

const commands: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const name of ["readFile", "writeFile", "removeFile", ...boot.commands]) {
  commands[name] = (...args: unknown[]) => runner.commands.triggerCommand(name, args);
}

export const server = {
  platform: boot.platform,
  version: boot.version,
  provider: boot.provider,
  browser: runner.config.browser.name,
  commands,
  config: runner.config,
};
export { commands };
export const userEvent = createUserEvent();
export { cdp, locators, page, utils };
