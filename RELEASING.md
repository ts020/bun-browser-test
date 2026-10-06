# リリース手順

bun-webview-test は [changesets](https://github.com/changesets/changesets) でバージョンを管理し、GitHub Actions から
npm の [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)（OIDC）で公開します。長期間有効な npm トークンは使いません。
Trusted Publishing で公開すると [provenance](https://docs.npmjs.com/generating-provenance-statements) も自動で付きます。

## ふだんの流れ

1. 利用者に影響する変更を入れる PR で、changeset を追加します。

   ```sh
   bun run changeset   # patch / minor / major と、CHANGELOG に載せる説明を書く
   ```

2. PR が main にマージされると、`.github/workflows/release.yml` が「bun-webview-test: Version Packages」
   という PR を作ります（たまった changeset から `package.json` の version と `CHANGELOG.md` を更新したもの）。
3. その PR をマージすると、同じワークフローが `changeset publish` で npm に公開し、タグを付けます。

1.0 になるまでは、破壊的な変更は minor、それ以外は patch で上げます。

## 最初の公開（1 回だけ）

npm の Trusted Publisher はパッケージの設定画面で登録するので、パッケージがまだ npm にない場合は先に手元から 1 回公開します。
（npm 側でパッケージ作成前に登録できるようになっていれば、2 は飛ばして 3 から進めて構いません。）

1. パッケージ名が空いていることを確かめます。

   ```sh
   npm view bun-webview-test   # 404 なら未使用
   ```

2. 手元から公開します（`prepublishOnly` で型定義がビルドされます）。

   ```sh
   bun install
   npm login
   npm publish --dry-run   # 中身を確認
   npm publish
   ```

3. npmjs.com で パッケージの Settings → Trusted Publisher → GitHub Actions を選び、次を登録します。

   | 項目 | 値 |
   | --- | --- |
   | Organization or user | `ts020` |
   | Repository | `bun-browser-test` |
   | Workflow filename | `release.yml` |
   | Environment | 空欄 |

4. 同じ Settings の Publishing access で「Require two-factor authentication and disallow tokens」を選ぶと、
   以後はトークンでの公開ができなくなり、Trusted Publishing だけになります（推奨）。

5. GitHub のリポジトリ設定 Settings → Actions → General → Workflow permissions で
   「Allow GitHub Actions to create and approve pull requests」を有効にします（Version Packages PR を作るのに必要です）。

## 補足

- Version Packages PR は `GITHUB_TOKEN` で作られるため、その PR では CI ワークフローが自動では走りません。
  必要ならその PR のブランチに空でないコミットを足すか、Actions の画面から手動で実行してください。
- 公開されるのは `src/`（TypeScript のまま）、`dist/`（型定義）、README、LICENSE、THIRD_PARTY_NOTICES.md です。
  Bun 専用のパッケージなので JavaScript へのビルドはしていません。中身は `npm pack --dry-run` で確認できます。
- CI では publint と [@arethetypeswrong/cli](https://github.com/arethetypeswrong/arethetypeswrong.github.io) で
  `exports` と型の設定を確認しています（`bun run lint:package`）。
