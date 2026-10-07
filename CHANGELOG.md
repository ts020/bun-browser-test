# bun-webview-test

## 0.3.0

### Minor Changes

- [#10](https://github.com/ts020/bun-browser-test/pull/10) [`dac0a47`](https://github.com/ts020/bun-browser-test/commit/dac0a474e653ceb95851fb89346e146b7ceb6392) Thanks [@ts020](https://github.com/ts020)! - Run Vitest-compatible browser tests in Firefox directly through WebDriver BiDi, without Playwright or geckodriver. Select the engine with BWT_BACKEND or backend configuration, isolate each test file in a fresh browser, and report unsupported CDP and raw WebView operations explicitly.

## 0.2.0

### Minor Changes

- [#6](https://github.com/ts020/bun-browser-test/pull/6) [`cefa892`](https://github.com/ts020/bun-browser-test/commit/cefa8920f91ac3105117dcc691ebfd411643f803) Thanks [@ts020](https://github.com/ts020)! - Use Chrome Headless Shell by default on every OS in both test APIs. Add `bun-webview-test install` to download a pinned browser directly from Chrome for Testing without extra npm dependencies. Reuse completed downloads, verify the published transfer checksum when available, and publish the cache only after successful extraction. Support explicit browser versions and cache directories, existing Playwright caches, custom Chrome executables, and opt-in WKWebView on macOS. Browser downloads remain a separate user command, with no install hook or automatic download during tests. Update setup and CI instructions and document browser compatibility differences.

### Patch Changes

- [#6](https://github.com/ts020/bun-browser-test/pull/6) [`cefa892`](https://github.com/ts020/bun-browser-test/commit/cefa8920f91ac3105117dcc691ebfd411643f803) Thanks [@ts020](https://github.com/ts020)! - Reuse Chrome tabs within a worker while recreating the browser document for each test file, and cache the immutable browser runtime. Reset tab state between files and discard tabs after raw CDP or custom WebView access. Avoid duplicate animation-frame waits before Chrome screenshots, with pixel regression coverage for styles, masks, and animations. Add isolation regression coverage and a reproducible comparison with Vitest Browser Mode, Chrome Headless Shell, and WKWebView.

- [#5](https://github.com/ts020/bun-browser-test/pull/5) [`90e6510`](https://github.com/ts020/bun-browser-test/commit/90e651055ceca49d81a7a4ef7c652752e8fc5139) Thanks [@ts020](https://github.com/ts020)! - Preserve Vitest runtime skips and todo results in Bun's test report. Avoid extra unnamed skipped tests in suites containing only skipped or todo tests, while continuing to report hook failures.
  
  Focus the tester iframe before loading tests so WKWebView applies `:focus` styles and reports `document.hasFocus()` correctly. Document backend differences and migration options for Tab, touch, hover, History, and CSS assertions.
