// automocked-default-return.test.ts（vi.mock('./src/calculator')）の書き換え
import { expect, test, vi } from 'vitest'
import { math } from './src/calculator'

test('returns undefined without mock implementation', () => {
  vi.spyOn(math, 'calculator').mockImplementation(() => undefined as any)
  expect(math.calculator('plus', 1, 2)).toBeUndefined()
})
