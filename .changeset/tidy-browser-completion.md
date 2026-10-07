---
"bun-webview-test": patch
---

Wait for the browser to consume its completion response before closing or reusing its page. Fail and close the page directly if completion remains pending for 30 seconds, and preserve completion RPC errors.
