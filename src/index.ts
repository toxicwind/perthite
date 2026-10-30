/**
 * perthite — public programmatic API.
 * Use these when embedding diff/merge in another tool instead of shelling to
 * the CLI. CLI entry is bin/perthite.js.
 */

import { splitLines, lcsOps, simpleDiff } from "./diff.ts";
import { runFFS, getMarkdownOutline, getOutline, buildSignatureMap, diffSignatures } from "./outline";
import { mergeThree, fastForward } from "./merge";


module.exports = {
  splitLines,
  lcsOps,
  simpleDiff,
  runFFS,
  getMarkdownOutline,
  getOutline,
  buildSignatureMap,
  diffSignatures,
  mergeThree,
  fastForward,
};