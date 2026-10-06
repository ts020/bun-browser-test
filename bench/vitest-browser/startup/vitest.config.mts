import { benchProvider } from '../provider.mts'
import { defineConfig } from 'vitest/config'


export default defineConfig({
  test: {
    include: ['trivial.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: benchProvider(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
