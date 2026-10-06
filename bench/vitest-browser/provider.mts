// BENCH_PROVIDER で vitest の browser provider を切り替える
// - playwright（既定）: @vitest/browser-playwright
// - bun: vitest-browser-bun（Bun.WebView。既定のファクトリは 1 ファイルずつ）
// - bun-parallel: vitest-browser-bun + bun-webview-parallel（ファイルごとに別の Bun ヘルパーと Chrome、プールあり）
import { playwright } from '@vitest/browser-playwright'
import { createParallelWebViewFactory } from 'bun-webview-parallel'
import { bunWebView } from 'vitest-browser-bun'

const chromePath = process.env.BENCH_CHROME_PATH ?? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1194/chrome-linux/chrome`
const args = process.getuid?.() === 0 ? ['--no-sandbox'] : []

export function benchProvider() {
  switch (process.env.BENCH_PROVIDER ?? 'playwright') {
    case 'bun':
      return bunWebView({ chromePath, chromeArgs: args })
    case 'bun-parallel':
      return bunWebView({ chromePath, chromeArgs: args, webViewFactory: createParallelWebViewFactory({ pool: true }) })
    default:
      return playwright({ launchOptions: { executablePath: chromePath, args } })
  }
}
