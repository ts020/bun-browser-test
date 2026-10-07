---
"bun-webview-test": minor
---

Use Chrome Headless Shell by default on every OS in both test APIs. Add `bun-webview-test install` to download a pinned browser directly from Chrome for Testing without extra npm dependencies. Reuse completed downloads, verify the published transfer checksum when available, and publish the cache only after successful extraction. Support explicit browser versions and cache directories, existing Playwright caches, custom Chrome executables, and opt-in WKWebView on macOS. Browser downloads remain a separate user command, with no install hook or automatic download during tests. Update setup and CI instructions and document browser compatibility differences.
