// import-actual-in-mock.test.ts（importOriginal で一部だけ差し替え）の書き換え
import { expect, test, vi } from 'vitest'
import { factory } from './src/mocks_factory'

test('actual is overriding import', () => {
  vi.spyOn(factory, 'mocked', 'get').mockReturnValue(true)
  expect(factory.mocked).toBe(true)
  // 差し替えていないものは元のまま
  expect(factory.calculator('plus', 1, 2)).toBe(3)
})
