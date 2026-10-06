// mocked-nested.test.ts（間接的に使われるモジュールの差し替え）の書き換え
import { expect, test, vi } from 'vitest'
import { nested } from './src/nested_child'
import { parent } from './src/nested_parent'

test('adds', () => {
  const child = vi.spyOn(nested, 'child').mockReturnValue(42 as any)
  expect(parent()).toBe(42)
  child.mockRestore()
})

test('actual', () => {
  expect(nested.child()).toBe(true)
})
