import { nested } from './nested_child'

export function parent() {
  return nested.child()
}
