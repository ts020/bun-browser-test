// mocked-do-mock-factory.test.ts（vi.doMock + 動的 import）の書き換え
import { expect, test, vi } from 'vitest'
import { factory } from './src/mocks_factory'

test('adds', async () => {
  vi.spyOn(factory, 'calculator').mockImplementation(() => 1166)
  vi.spyOn(factory, 'mocked', 'get').mockReturnValue(true)

  // 動的 import でも同じモジュールのインスタンスが返るので、差し替えが見える
  const mod = await import('./src/mocks_factory')
  expect(mod.factory.mocked).toBe(true)
  expect(mod.factory.calculator('plus', 1, 2)).toBe(1166)
})
