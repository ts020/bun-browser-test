# vitest のブラウザモードのテストの移植

[vitest](https://github.com/vitest-dev/vitest) v5.0.3 の `test/browser` を、このパッケージで動くように移植したもの（MIT License, Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors）。

- `test/` … vitest の `test/browser/test`。設定は `bwt.config.ts`（元は `vitest.config.mts`）
- `fixtures/` … vitest の `test/browser/fixtures` のうち移植したもの。各ディレクトリの `vitest.config.ts` を `bwt.config.ts` に置き換えている
- 失敗することを確かめる fixtures は `bunfig.toml` の `pathIgnorePatterns` で普段の `bun test` から外している

テストの中身は、ディレクトリ名に依存する部分も含めて元のまま。
