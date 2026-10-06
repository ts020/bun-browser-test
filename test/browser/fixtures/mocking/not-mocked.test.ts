import { expect, test } from 'vitest'
import { math } from './src/calculator'

test('adds', () => {
  expect(math.calculator('plus', 1, 2)).toBe(3)
})
