// Adapted from @vitest/browser-playwright/src/locators.ts (MIT, https://github.com/vitest-dev/vitest)
// ページは iframe ではなくトップレベルで動くので、iframe の拡大率の補正は不要。
// @ts-ignore
import { getByAltTextSelector, getByLabelSelector, getByPlaceholderSelector, getByRoleSelector, getByTestIdSelector, getByTextSelector, getByTitleSelector, Locator, selectorEngine } from "@vitest/browser/locators";
import { page, server } from "vitest/browser";
// @ts-ignore
import { __INTERNAL } from "vitest/internal/browser";

export class PlaywrightLocator extends Locator {
  constructor(
    public selector: string,
    protected _container?: Element,
  ) {
    super();
  }

  protected locator(selector: string) {
    return new PlaywrightLocator(`${this.selector} >> ${selector}`, this._container);
  }

  protected elementLocator(element: Element) {
    return new PlaywrightLocator(selectorEngine.generateSelectorSimple(element), element);
  }
}

(page as any).extend({
  getByLabelText(text: string | RegExp, options?: any) {
    return new PlaywrightLocator(getByLabelSelector(text, options));
  },
  getByRole(role: string, options?: any) {
    return new PlaywrightLocator(getByRoleSelector(role, options));
  },
  getByTestId(testId: string | RegExp) {
    return new PlaywrightLocator(getByTestIdSelector(server.config.browser.locators.testIdAttribute, testId));
  },
  getByAltText(text: string | RegExp, options?: any) {
    return new PlaywrightLocator(getByAltTextSelector(text, options));
  },
  getByPlaceholder(text: string | RegExp, options?: any) {
    return new PlaywrightLocator(getByPlaceholderSelector(text, options));
  },
  getByText(text: string | RegExp, options?: any) {
    return new PlaywrightLocator(getByTextSelector(text, options));
  },
  getByTitle(title: string | RegExp, options?: any) {
    return new PlaywrightLocator(getByTitleSelector(title, options));
  },
  elementLocator(element: Element) {
    return new PlaywrightLocator(selectorEngine.generateSelectorSimple(element), element);
  },
  frameLocator(locator: { selector: string }) {
    return new PlaywrightLocator(`${locator.selector} >> internal:control=enter-frame`);
  },
});

__INTERNAL._createLocator = (selector: string) => new PlaywrightLocator(selector);
