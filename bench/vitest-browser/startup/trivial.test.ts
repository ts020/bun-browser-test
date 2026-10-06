// 起動・終了のコストを測るための、1 件だけのブラウザテスト
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

test('renders', async () => {
  document.body.innerHTML = '<button>ok</button>'
  await expect.element(page.getByRole('button')).toHaveTextContent('ok')
})
