export { configure, getConfig, type BrowserConfig } from "./config";
export { expectElement, type ElementAssertions, type ExpectElementOptions } from "./expect-element";
export {
  Locator,
  StrictModeError,
  type ActionOptions,
  type ClickOptions,
  type FilterOptions,
  type RoleOptions,
  type TextInput,
  type TextOptions,
} from "./locator";
export { ModuleHandle, page, type Page, type ScreenshotOptions } from "./page";
export type { PageError } from "./protocol";
export { closeSession as closeBrowser, getSession } from "./session";
export { userEvent } from "./user-event";

import type { expectElement } from "./expect-element";

declare module "bun:test" {
  interface Expect {
    /** ブラウザ内の要素に対するリトライ付きアサーション。preload で登録される。 */
    element: typeof expectElement;
  }
}
