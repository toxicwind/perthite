# perthite — design

## Problem

Engineers reconcile two diverged checkouts of the same repo (a stray duplicate
and the canonical copy). Hand-porting files is error-prone: content gets
dropped, or both sides' edits get clobbered. Generic `diff` tools show *what*
differs but not *where it matters structurally*.

## Approach

Two complementary engines in one CLI:

1. **Structural (diff mode)** — shell out to `ffs outline --format json` and
   compare symbol signatures. This rank-orders *changed surfaces* (added /
   removed / changed functions, classes, imports) so the user sees the blast
   radius, not just the text delta. Markdown files use their heading tree.

2. **Three-way (merge mode)** — delegate the actual line merge to git's
   `merge-file`, which implements battle-tested diff3 with base anchoring:
   - one-side change  -> taken verbatim
   - identical change -> taken once
   - both sides diverge -> `<<<<<<< ours / ======= / >>>>>>> theirs` conflict
   This never double-emits shared context lines (a trap the hand-rolled LCS
   alignment fell into) and never drops an edit.

## Why shell to git for merge?

A hand-rolled diff3 is fragile (LCS tie-breaking misfires on adjacent
edits). Git's `merge-file` is the proven engine and is guaranteed present on
the estate host, so we borrow it instead of re-inventing — same reasoning as
`ffs` borrowing tree-sitter.

## Exit codes

- diff mode: 0 (or 1 on bad args / missing files)
- merge mode: 0 = clean merge, 1 = any conflict (and JSON still emitted with
  `--json` for programmatic resolution)