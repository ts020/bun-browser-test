---
"bun-webview-test": patch
---

Preserve Vitest runtime skips and todo results in Bun's test report. Avoid extra unnamed skipped tests in suites containing only skipped or todo tests, while continuing to report hook failures.

Focus the tester iframe before loading tests so WKWebView applies `:focus` styles and reports `document.hasFocus()` correctly. Document backend differences and migration options for Tab, touch, hover, History, and CSS assertions.
