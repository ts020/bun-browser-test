// Copied into .scaling by scaling.py; both runners use the same generated root.
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: local('./'),
  define: {'import.meta.env.DEFINE_CUSTOM_ENV': JSON.stringify('define-custom-env')},
  resolve: { alias: {
    '#src': local('./src'),
    '@vitest/cjs-lib': local('./cjs-lib'),
    '@vitest/bundled-lib': local('./bundled-lib'),
  } },
  optimizeDeps: { include: ['@vitest/cjs-lib', '@vitest/bundled-lib'] },
  test: {
    include: ['g*/test/*.test.ts'],
    env: { CUSTOM_ENV: 'foo' },
    maxWorkers: Number(process.env.BENCH_WORKERS ?? 4),
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { executablePath: process.env.BUN_CHROME_PATH } }),
      instances: [{ browser: 'chromium' }],
      viewport: { width: 414, height: 896 },
      testerHtmlPath: './custom-tester.html',
      commands: { stripVTControlCharacters: (_, text: string) => stripVTControlCharacters(text) },
    },
  },
});
