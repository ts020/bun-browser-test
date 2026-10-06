import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const executablePath = process.env.BENCH_CHROME_PATH ?? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1194/chrome-linux/chrome`

export default defineConfig({
  test: {
    include: ['trivial.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { executablePath, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] } }),
      instances: [{ browser: 'chromium' }],
    },
  },
})
