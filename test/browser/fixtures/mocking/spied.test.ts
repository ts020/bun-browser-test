// automocked.test.ts（vi.mock('./src/calculator')）の書き換え
import { afterEach, expect, test, vi } from 'vitest'
import { math } from './src/calculator'

afterEach(() => {
  vi.restoreAllMocks()
})

test('adds', () => {
  vi.spyOn(math, 'calculator').mockReturnValue(4)
  expect(math.calculator('plus', 1, 2)).toBe(4)
})

test('restored after the previous test', () => {
  expect(vi.isMockFunction(math.calculator)).toBe(false)
  expect(math.calculator('plus', 1, 2)).toBe(3)
})
