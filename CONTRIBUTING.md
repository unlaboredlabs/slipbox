# Contributing

Bug reports and small, focused pull requests are welcome. For anything larger, open an issue first so we can agree on the approach.

slipbox aims to stay small: plain files, git, one program, eight tools. A change that adds a feature should explain why the existing ones cannot do it.

## Before you open a pull request

You need [Bun](https://bun.sh) (the version in `.bun-version`) and git.

```sh
bun install
bun run typecheck
bun test
```

- Add a test for any change in behaviour.
- If you change the dashboard API or the tools, update [DESIGN.md](DESIGN.md).
- Keep the docs plain and short.

Pull requests are squash-merged into `main`. Every merge is released to everyone as the next `edge` build, so `main` must always work.

Report security issues privately, as [SECURITY.md](SECURITY.md) says.
