---
"bun-webview-test": patch
---

Reuse Chrome tabs within a worker while recreating the browser document for each test file, and cache the immutable browser runtime. Reset tab state between files and discard tabs after raw CDP or custom WebView access. Avoid duplicate animation-frame waits before Chrome screenshots, with pixel regression coverage for styles, masks, and animations. Add isolation regression coverage and a reproducible comparison with Vitest Browser Mode, Chrome Headless Shell, and WKWebView.
