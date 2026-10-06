// mocked-factory.test.ts（vi.mock(path, factory)）の書き換え
import { expect, test, vi } from 'vitest'
import { factory } from './src/mocks_factory'
import { dep1 } from './src/mocks_factory_many_dep1'
import { dep2 } from './src/mocks_factory_many_dep2'
import { many } from './src/mocks_factory_many'

test('adds', () => {
  vi.spyOn(factory, 'calculator').mockImplementation(() => 1166)
  vi.spyOn(factory, 'mocked', 'get').mockReturnValue(true)

  vi.spyOn(dep1, 'value', 'get').mockReturnValue('dep1-mocked')
  vi.spyOn(dep2, 'value', 'get').mockReturnValue('dep2-mocked')

  expect(factory.mocked).toBe(true)
  expect(factory.calculator('plus', 1, 2)).toBe(1166)

  expect(many()).toEqual({
    dep1: 'dep1-mocked',
    dep2: 'dep2-mocked',
  })
})
