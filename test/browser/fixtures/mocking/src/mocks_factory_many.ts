import { dep1 } from './mocks_factory_many_dep1'
import { dep2 } from './mocks_factory_many_dep2'

export function many() {
  return { dep1: dep1.value, dep2: dep2.value }
}
