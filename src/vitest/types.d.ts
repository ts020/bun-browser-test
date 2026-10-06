// `vitest/browser` の型は @vitest/browser-playwright などのプロバイダーのパッケージから来る。
// このパッケージはプロバイダーを使わないので、同じ型を @vitest/browser から渡す。
// tsconfig の compilerOptions.types に "bun-webview-test/vitest-types" を足すと有効になる。
/// <reference types="@vitest/browser/matchers" />

declare module "@vitest/browser-playwright/context" {
  export * from "@vitest/browser/context";
}
