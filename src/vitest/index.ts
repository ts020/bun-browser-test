// bun-webview-test/vitest: bwt.config.ts から使う設定まわりの API
export {
  type BrowserCommand,
  type BrowserCommandContext,
  type BrowserModeConfig,
  type ProjectConfig,
  configureBrowserMode,
  defineConfig,
  getBrowserModeConfig,
} from "./config";
