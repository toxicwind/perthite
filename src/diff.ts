/**
 * Line-level diff primitives.
 * Patterns borrowed from:
 *   - compute-line-diff.ts (beellama.cpp): line-level LCS DP
 *   - diffHelper.ts (flocksync): token-level LCS with DP backtrace
 */

function splitLines(text) {
  return text.replace(/\n$/, "").split("\n");
}

/** LCS-based diff of two line arrays into eq/rep ops (ordered head -> tail). */
function lcsOps(a, b) {
  const m = a.length, n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      lcs[i][j] = a[i - 1] === b[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
  const ops = [];
  let i = m, j = n;
  let rep = [];
  const flush = () => { if (rep.length) { ops.unshift({ type: "rep", lines: rep }); rep = []; } };
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { flush(); ops.unshift({ type: "eq", line: a[i - 1] }); i--; j--; }
    else if (lcs[i - 1][j] >= lcs[i][j - 1]) { rep.unshift(a[i - 1]); i--; }
    else { rep.unshift(b[j - 1]); j--; }
  }
  while (i > 0) { rep.unshift(a[i - 1]); i--; }
  while (j > 0) { rep.unshift(b[j - 1]); j--; }
  flush();
  return ops;
}

/** Human-friendly unified preview limited to maxLines. */
function simpleDiff(aText, bText, maxLines = 80) {
  const aLines = splitLines(aText);
  const bLines = splitLines(bText);
  if (aLines.length === 0 && bLines.length === 0) return [];
  const ops = lcsOps(aLines, bLines);
  const out = [];
  for (const op of ops) {
    if (op.type === "eq") out.push({ kind: "context", text: op.line });
    else for (const ln of op.lines) out.push({ kind: "remove", text: ln });
  }
  return out.slice(0, maxLines * 3);
}

export { splitLines, lcsOps, simpleDiff };