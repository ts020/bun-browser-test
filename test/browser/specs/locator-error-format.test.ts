// vitest の test/browser/specs/locator-error-format.test.ts の移植
import { expect, test } from "bun:test";
import { errorOf, runBrowserTests } from "./utils";

const LONG = 60_000;

const HEADER = "Cannot find element with locator: getByRole('button', { name: 'Save' })";
const ARIA = `ARIA tree:
- main:
  - heading "Settings" [level=1]
  - button "Cancel"`;
const HTML = `<body>
  
    
  <main>
    
      
    <h1>
      Settings
    </h1>
    
      
    <button>
      Cancel
    </button>
    
    
  </main>
  
  
</body>`;

async function notFoundError(errorFormat?: string) {
  const { stderr } = await runBrowserTests("locator-error-format", {
    config: { screenshotFailures: false, ...(errorFormat ? { locators: { errorFormat } } : {}) },
  });
  const error = errorOf(stderr, "not found");
  // 先頭の "VitestBrowserElementError: " と、末尾のスタックを除いた本文
  return error
    .replace(/^VitestBrowserElementError: /, "")
    .replace(/\n\s+at [^\n]+$/, "")
    .trimEnd();
}

test("locator error format aria", async () => {
  expect(await notFoundError("aria")).toBe(`${HEADER}\n\n${ARIA}`);
}, LONG);

test("locator error format html", async () => {
  expect(await notFoundError("html")).toBe(`${HEADER}\n\n${HTML}`);
}, LONG);

test("locator error format all", async () => {
  // default
  expect(await notFoundError()).toBe(`${HEADER}\n\n${ARIA}\n\nHTML:\n${HTML}`);
}, LONG);
