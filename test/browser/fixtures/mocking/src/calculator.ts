import { actions } from './actions'

export const math = {
  calculator(operation: 'plus', a: number, b: number) {
    if (operation === 'plus')
      return actions.plus(a, b)

    throw new Error('unknown operation')
  },
}
