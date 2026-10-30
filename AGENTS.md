# AGENTS.md — perthite

Standalone ranch repo for the `perthite` CLI (diff + three-way merge).

- Node (`commonjs`), zero runtime deps. Structural outlines come from the
  estate `ffs` binary (`bin/ffs`); merge mode shells to `git merge-file`.
- Merge mode never mutates inputs in place unless `--output <file>` is given;
  it prints to stdout (or `--output`) and exits `0` clean / `1` conflicts.
- Conflict markers are `<<<<<<< ours / ======= / >>>>>>> theirs`.
- Keep it additive and doctrinally quiet: no secrets, LF + ASCII, no
  hardcoded `github.com/<owner>/<repo>` URLs (reference peers by local path).
- Verify with `./bin/perthite.js --help` and `bun test tests/`.