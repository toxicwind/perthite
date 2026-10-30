# Contributing to perthite

Thanks for improving `perthite`. Keep every change small, additive, and true to
the design: **diff** surfaces structure via `ffs`; **merge** delegates to git's
`merge-file`. Never hand-roll a diff3 where git already has one.

## Getting started

```bash
bun test tests/       # diff, outline, merge suites
```

## Rules

- **No secrets.** No real keys, tokens, or bearer values — ever, in any file.
- **LF + ASCII.** The repo and its tooling assume LF line endings and
  printable ASCII; no trailing whitespace on lines.
- **No hardcoded `github.com/<owner>/<repo>` URLs.** Reference sibling ranch
  repos by local path, or resolve via `git -C <path> remote get-url origin`.
  (The README is the one exception — it links the published repo/tools.)
- **Additive first.** Prefer adding to `src/` modules over growing
  `bin/perthite.js` (the entry stays thin).
- **Merge never drops content.** A change is only "safe" if it doesn't lose
  either side's edit; conflicts must surface markers, never silently resolve.

## What makes a good PR

1. One logical change (fix a bug, add a module, extend the API).
2. A test that fails on `main` and passes with your change.
3. `bun test tests/` fully green before you push.
4. Updates to `docs/ARCHITECTURE.md` → `docs/DESIGN.md` if behavior changed.

## Issue template

For a bug or question, a PR is even better than an issue — but if you open one,
include the exact `perthite` invocation and the three file versions
(base/ours/theirs) or a minimal reproducer.