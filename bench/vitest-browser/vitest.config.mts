// vitest v5.0.3 の test/browser/vitest.config.mts を元に、比較用に変えたもの:
// - Chromium のみ・ヘッドレス、bun-webview-test と同じ Chromium バイナリ（PLAYWRIGHT_BROWSERS_PATH）を使う
// - typecheck / benchmark / outputFile / trace コマンド / snapshotEnvironment を外す（bun-webview-test 側にないため）
import type { BrowserCommand } from 'vitest/node'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as util from 'node:util'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const dir = dirname(fileURLToPath(import.meta.url))
const executablePath = process.env.BENCH_CHROME_PATH ?? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1194/chrome-linux/chrome`

const myCustomCommand: BrowserCommand<[arg1: string, arg2: string]> = ({ testPath }, arg1, arg2) => {
  return { testPath, arg1, arg2 }
}
const stripVTControlCharacters: BrowserCommand<[text: string]> = (_, text) => util.stripVTControlCharacters(text)

export default defineConfig({
  server: {
    headers: {
      'x-custom': 'hello',
      'X-Frame-Options': 'DENY',
      'content-security-policy': 'frame-src https://example.com; frame-ancestors https://example.com',
    },
  },
  optimizeDeps: {
    include: ['@vitest/cjs-lib', '@vitest/bundled-lib', 'react/jsx-dev-runtime'],
  },
  define: {
    'import.meta.env.DEFINE_CUSTOM_ENV': JSON.stringify('define-custom-env'),
  },
  test: {
    include: ['test/**.test.{ts,js,tsx}'],
    env: { CUSTOM_ENV: 'foo' },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { executablePath, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] },
      }),
      instances: [{ browser: 'chromium' }],
      testerHtmlPath: './custom-tester.html',
      orchestratorScripts: [
        { content: 'console.log("Hello, World");globalThis.__injected = []', type: 'text/javascript' },
        { content: 'import "./injected.ts"' },
        { content: 'if(__injected[0] !== 2) throw new Error("injected not working")' },
      ],
      commands: { myCustomCommand, stripVTControlCharacters },
    },
    tags: [
      { name: 'e2e', priority: 10 },
      { name: 'test', priority: 5 },
      { name: 'browser', priority: 1 },
    ],
    alias: { '#src': resolve(dir, './src') },
    diff: './custom-diff-config.ts',
    onConsoleLog(log) {
      if (log.includes('MESSAGE ADDED')) return false
    },
  },
  plugins: [
    {
      name: 'my-ssr',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url || '', 'http://localhost')
          if (url.pathname.startsWith('/api/')) {
            try {
              const mod = await server.ssrLoadModule('./test/server/entry.ts')
              res.end(JSON.stringify(await mod.default(url)))
              return
            } catch (e) {
              next(e)
              return
            }
          }
          next()
        })
      },
    },
  ],
})
