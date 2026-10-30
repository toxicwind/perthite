# perthite

**Structural diff + three-way merge for the estate, ffs/tree-sitter aware.**

Diff two files by their *shape* (functions, classes, imports) first, or merge
two diverged revisions against a common base in one command — without dropping
either side's edit.

```bash
# Diff two files by structure, then body
perthite src/a.ts src/b.ts --full

# Merge two diverged checkouts (base ours theirs), clean or conflict-marked
perthite f38e1329.ts ours.ts theirs.ts --merge --output merged.ts
```

A clean merge exits `0`; any conflict exits `1` and writes
`<<<<<<< ours / ======= / >>>>>>> theirs` markers.

---

## Install

Runs on node ≥ 20 / bun ≥ 1.4.4, zero runtime deps. It shells to git's
`merge-file` (merge mode) and the estate's `ffs` binary (structural diff).

```bash
ln -sf "$(pwd)/bin/perthite.js" ~/.local/bin/perthite   # link onto PATH
# or: npm link  /  bun install + bun run --bin perthite
```

## Modules & API

Every capability is a composable, `require`-able module — no need to shell to
the CLI:

| Module | Exports | Package entry |
| ------ | ------- | ------------- |
| [`src/diff.js`](src/diff.js) | `splitLines` · `lcsOps` · `simpleDiff` | line primitives |
| [`src/outline.js`](src/outline.js) | `getOutline` · `getMarkdownOutline` · `buildSignatureMap` · `diffSignatures` | structure |
| [`src/merge.js`](src/merge.js) | `mergeThree` · `fastForward` | diff3 via git |
| [`src/index.js`](src/index.js) | the full public API | `require("perthite")` |

```js
const { mergeThree, getOutline, diffSignatures } = require("perthite");
const { merged, conflicts } = mergeThree(basePath, oursPath, theirsPath);
```

See [docs/DESIGN.md](docs/DESIGN.md) for the diff3 rationale and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for layout; [AGENTS.md](AGENTS.md)
is the component contract.

## Why it exists

Reconciling two diverged checkouts of the same repo (a stray duplicate and the
canonical copy) by hand-porting files drops content or clobbers an edit. `diff`
shows *what* differs, not *where it matters structurally*. `perthite` ranks the
changed surfaces via tree-sitter outlines, then merges with git's proven diff3
engine.

## Tests & status

```bash
bun test tests/   # diff, outline, merge suites — all green
```

Registered as a first-class ranch project in both pipelines:

| Tool | Role | Status |
| ---- | ---- | ------ |
| [meta](https://github.com/toxicwind/meta) | repo-graph sync (`ranch/.meta.yaml`) | `perthite | main | clean` |
| [moon](https://github.com/toxicwind/moon) | build/task graph (`ranch/.moon`) | project `id: perthite` |

## License

[MIT](LICENSE)