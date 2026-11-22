# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fajarekomulyawan/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fajarekomulyawan/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. mend applies an edit a model wrote to a tree of text files, reading all
four formats models use — unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and
text-editor tool calls as JSON — to the one specification in SPEC.md. It finds the lines an edit names at the
first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-trimmed, re-indenting
new lines to the file's own indent at the loosest tier), and changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is a patch file, or standard input when it is absent or `-`. `--format` is one of `unified`,
`search-replace`, `v4a`, `json` or the default `auto`. `--check` reports without writing; `--strict` matches
lines exactly. Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new` for a move) and an
`ok:` summary; exit 1 prints one `error:` line per failed edit and writes nothing; exit 2 prints a single
usage, no-patch, format or parse error line.

---

Entered on [make.fun](https://make.fun/?ref=qtz&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
