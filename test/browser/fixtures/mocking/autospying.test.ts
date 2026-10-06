// autospying.test.ts（vi.mock(path, { spy: true })）の書き換え
import { expect, test, vi } from 'vitest'
import { actions } from './src/actions'
import { math } from './src/calculator'

test('correctly spies on a regular module', () => {
  const spy = vi.spyOn(math, 'calculator')
  expect(math.calculator('plus', 1, 2)).toBe(3)
  expect(spy).toHaveBeenCalledWith('plus', 1, 2)
})

test('spies on a dependency used inside another module', () => {
  const plus = vi.spyOn(actions, 'plus')
  expect(math.calculator('plus', 1, 2)).toBe(3)
  expect(plus).toHaveBeenCalledWith(1, 2)
})
