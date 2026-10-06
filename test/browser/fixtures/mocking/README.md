vitest の `test/browser/fixtures/mocking` を、`vi.mock` を使わない形に書き換えたもの。

ブラウザの ES モジュールの名前空間は書き換えられないので（`vi.spyOn(ns, "fn")` は TypeError）、
差し替えたい関数はオブジェクトのメソッドとして export し、そのオブジェクトを `vi.spyOn` で差し替える。
自動モック（`vi.mock(path)` / `vi.importMock`）、`__mocks__`、`?raw` へのファクトリ、パスのエイリアス違いの判定は
`vi.mock` そのものの機能なので移植していない。
