# Changesets

このディレクトリには [changesets](https://github.com/changesets/changesets) の変更記録を置きます。
利用者に影響する変更を入れる PR では、リポジトリのルートで次を実行して changeset を 1 つ追加してください。

```sh
bun run changeset
```

main にマージされると、リリース用のワークフローがバージョンを上げる PR（「Version Packages」）を作ります。
その PR をマージすると npm に公開されます。詳しくは [RELEASING.md](../RELEASING.md) を見てください。
