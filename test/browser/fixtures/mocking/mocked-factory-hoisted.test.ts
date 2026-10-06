// mocked-factory-hoisted.test.ts（vi.hoisted + vi.mock）の書き換え
import { expect, test, vi } from 'vitest'
import { factory } from './src/mocks_factory'

const fn = vi.fn()
vi.spyOn(factory, 'calculator').mockImplementation(fn)

test('adds', () => {
  fn.mockReturnValue(448)
  expect(factory.calculator('plus', 1, 2)).toBe(448)
  expect(fn).toHaveBeenCalledWith('plus', 1, 2)
})
