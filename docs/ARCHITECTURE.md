# perthite — architecture

```
bin/perthite.js    CLI entry: argv dispatch only
src/
  diff.js          splitLines · lcsOps · simpleDiff      (line primitives)
  outline.js       ffs outline · markdown headings · sig diff
  merge.js         mergeThree (git merge-file) · fastForward
  cli.js           parseArgs · help · diff/merge rendering
  index.js         public API re-export
tests/
  diff.test.ts · outline.test.ts · merge.test.ts
```

## Flow

- **Diff mode** `bin/perthite a b [--full]`
  1. `getOutline` shells to `ffs outline --format json` (code) or walks the
     heading tree (markdown).
  2. `buildSignatureMap` keys symbols as `kind:name`.
  3. `diffSignatures(base, next)` → added / removed / changed. `--full` adds a
     unified line preview via `simpleDiff`.

- **Merge mode** `bin/perthite base ours theirs --merge`
  1. `fastForward` short-circuits when one side equals base (auto-clean).
  2. `mergeThree` runs `git merge-file -p ours base theirs` — battle-tested
     diff3 with base anchoring.
  3. Conflict markers `<<<<<<< ours / ======= / >>>>>>> theirs`; `conflicts`
     is the open-marker count. Exit `0` clean / `1` conflicts.

## Design decisions

- **git for diff3, not a hand-rolled LCS** — a naive per-base-line alignment
  double-emits shared context lines when LCS tie-breaking misfires on adjacent
  edits. Git's merge engine is guaranteed present and correct.
- **ffs for structure** — borrow the codebase's tree-sitter index instead of
  shipping another parser.
- **Modules over monolith** — each responsibility is `require`-able so other
  estate tools embed the API without shelling to a CLI.