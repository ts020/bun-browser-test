export const factory = {
  calculator(_action: string, _a: number, _b: number) {
    return _a + _b
  },
  get mocked(): boolean {
    return false
  },
}
