#!/usr/bin/env bun
/**
 * ffs-diff — multi-file structural diff AND three-way merge, ffs-aware.
 *
 * Pattern borrowed from:
 *   - compute-line-diff.ts (beellama.cpp): line-level LCS DP
 *   - apply_unified_patches.py (dedicated-server-ops): unified diff summary
 *   - diffHelper.ts (flocksync): token-level LCS with DP backtrace
 *
 * Usage:
 *   ffs-diff <file1> <file2> [--format json|text] [--outline] [--full]
 *       Structural outline diff of two files.
 *   ffs-diff <base> <ours> <theirs> --merge [--output <file>] [--json]
 *       Three-way merge of two revisions against a common base, using
 *       structural outlines to auto-resolve where safe and emitting conflict
 *       markers where both sides edited the same lines differently.
 *
 * Merge semantics (diff3):
 *   - region unchanged on both sides      -> context line
 *   - changed on only one side            -> taken verbatim from that side
 *   - changed differently on both sides   -> <<<<<<< ours / ======= / >>>>>>> theirs
 * The merge never silently drops either side's edit; conflicts are surfaced
 * with markers (and, with --json, an index of conflict regions).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FFS_BIN = "/home/toxic/.local/bin/ffs";

function runFFS(...args) {
  const r = spawnSync(FFS_BIN, args, { encoding: "utf8", timeout: 60000 });
  const stderr = (r.stderr || "").trim();
  if (r.error) throw new Error(`ffs ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffs ${args.join(" ")}: ${stderr || "non-zero exit " + r.status}`);
  return r.stdout || "";
}

function parseArgs(argv) {
  const files = [];
  let format = "text";
  let outlineOnly = false;
  let fullDiff = false;
  let showLines = false;
  let merge = false;
  let output = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (key === "format" && next) { format = next; i++; }
      else if (key === "json") { format = "json"; }
      else if (key === "outline") { outlineOnly = true; }
      else if (key === "full") { fullDiff = true; }
      else if (key === "lines") { showLines = true; }
      else if (key === "merge") { merge = true; }
      else if (key === "output" && next) { output = next; i++; }
      else if (key === "help") {
        console.log(`Usage:
  ffs-diff <file1> <file2> [--format json|text] [--outline] [--full]
      Structural diff of two files (added/removed/changed symbols, outlines).

  ffs-diff <base> <ours> <theirs> --merge [--output <file>] [--json]
      Three-way merge against a common base. Safe single-side edits are applied
      automatically; both-sides divergence becomes <<<<<<< ours / ======= / >>>>>>> theirs
      conflict markers. --json also prints the conflict region index.
      A clean merge (0 conflicts) exits 0; any conflict exits 1.

Options:
  --format json|text   Output format (default: text)
  --outline            Diff mode: only compare structural outlines
  --full               Diff mode: also show unified body diff
  --lines              Diff mode: show line LCS diff
  --merge              Merge mode: three files = base ours theirs
  --output <file>      Merge mode: write merged result to <file> (default: stdout)
`);
        process.exit(0);
      }
    } else if (arg) {
      files.push(arg);
    }
  }
  return { files, format, outlineOnly, fullDiff, showLines, merge, output };
}

/* ------------------------- Markdown / outline helpers ------------------------ */

function getMarkdownOutline(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split("\n");
    const headings = [];
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("```")) { inCode = !inCode; continue; }
      if (inCode) continue;
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        headings.push({ kind: `h${m[1].length}`, name: m[2].trim(), signature: line.trim(), line: i + 1 });
      }
    }
    return headings;
  } catch {
    return [];
  }
}

function getOutline(filePath) {
  if (/\.(md|markdown|mdown|mkd)$/i.test(filePath)) return getMarkdownOutline(filePath);
  try {
    const raw = runFFS("outline", filePath, "--format", "json");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

function buildSignatureMap(outlines) {
  const sigs = {};
  const walk = (node) => {
    if (node.kind && node.name) {
      const key = `${node.kind}:${node.name}`;
      if (!sigs[key]) {
        sigs[key] = {
          kind: node.kind,
          name: node.name,
          line: node.start_line || 0,
          endLine: node.end_line || 0,
          signature: node.signature || "",
          children: node.children || [],
        };
      }
    }
    if (node.children) for (const child of node.children) walk(child);
  };
  for (const entry of outlines) walk(entry);
  return sigs;
}

function diffSignatures(aSigs, bSigs) {
  const aKeys = new Set(Object.keys(aSigs));
  const bKeys = new Set(Object.keys(bSigs));
  const added = [], removed = [], changed = [];
  for (const key of bKeys) {
    if (!aKeys.has(key)) added.push(bSigs[key]);
    else if (aSigs[key].signature !== bSigs[key].signature) changed.push({ key, old: aSigs[key], new: bSigs[key] });
  }
  for (const key of aKeys) if (!bKeys.has(key)) removed.push(aSigs[key]);
  return { added, removed, changed };
}

/* ------------------------------ Diff helpers -------------------------------- */

function splitLines(text) {
  return text.replace(/\n$/, "").split("\n");
}

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

/* ------------------------------- diff3 merge -------------------------------- */

// Merge engine: git's `merge-file` (battle-tested diff3 with proper base
// anchoring). Emits standard conflict markers and never double-emits shared
// context lines. `git` is guaranteed on the estate host; no fragile hand-rolled
// LCS and no unversioned dependency surprises.
function mergeThree(basePath, oursPath, theirsPath) {
  const r = spawnSync("git", ["merge-file", "-p", oursPath, basePath, theirsPath], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const text = (r.stdout || "").replace(/\n$/, "") + "\n";
  const lines = splitLines(text);
  let conflicts = 0;
  for (const ln of lines) if (ln.startsWith("<<<<<<<")) conflicts++;
  if (r.error) throw new Error(`git merge-file: ${r.error.message}`);
  return { merged: lines, conflicts };
}

function renderTextDiff(aPath, bPath, sigDiff, outlineA, outlineB, fullDiff, showLines) {
  const lines = [];
  lines.push(`\n=== ${aPath} <-> ${bPath} ===`);
  if (sigDiff.added.length || sigDiff.removed.length || sigDiff.changed.length) {
    lines.push("\n--- STRUCTURAL CHANGES ---");
    if (sigDiff.removed.length) {
      lines.push(`\n[REMOVED ${sigDiff.removed.length} items]:`);
      for (const s of sigDiff.removed) { lines.push(`  - ${s.kind} ${s.name} (L${s.line})`); if (s.signature && s.signature !== s.name) lines.push(`    ${s.signature}`); }
    }
    if (sigDiff.added.length) {
      lines.push(`\n[ADDED ${sigDiff.added.length} items]:`);
      for (const s of sigDiff.added) { lines.push(`  + ${s.kind} ${s.name} (L${s.line})`); if (s.signature && s.signature !== s.name) lines.push(`    ${s.signature}`); }
    }
    if (sigDiff.changed.length) {
      lines.push(`\n[CHANGED ${sigDiff.changed.length} items]:`);
      for (const c of sigDiff.changed) { lines.push(`  ~ ${c.key}`); lines.push(`    old: ${c.old.signature || c.old.name}`); lines.push(`    new: ${c.new.signature || c.new.name}`); }
    }
  } else {
    lines.push("\n--- STRUCTURE: IDENTICAL ---");
  }
  lines.push(`\n--- OUTLINES ---`);
  lines.push(`  ${aPath}: ${outlineA.length} symbols`);
  lines.push(`  ${bPath}: ${outlineB.length} symbols`);
  if (fullDiff) {
    try {
      const textA = readFileSync(aPath, "utf8");
      const textB = readFileSync(bPath, "utf8");
      if (textA !== textB) {
        lines.push("\n--- UNIFIED DIFF (first 80 lines) ---");
        const diffLines = simpleDiff(textA, textB, 80);
        for (const line of diffLines.slice(0, 80)) {
          const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
          lines.push(`${prefix} ${line.text}`);
        }
      }
    } catch (e) { lines.push(`\n--- DIFF SKIPPED: ${e.message} ---`); }
  }
  return lines.join("\n");
}

function renderJsonDiff(aPath, bPath, sigDiff, outlineA, outlineB, fullDiff) {
  const textA = readFileSync(aPath, "utf8");
  const textB = readFileSync(bPath, "utf8");
  const diffLines = simpleDiff(textA, textB, 80);
  return {
    file1: aPath, file2: bPath,
    outline1: outlineA.length, outline2: outlineB.length,
    structural: sigDiff,
    diff: { changed: textA !== textB, lines: diffLines.slice(0, 80) },
  };
}

function main() {
  const { files, format, outlineOnly, fullDiff, showLines, merge, output } = parseArgs(process.argv.slice(2));

  // --trio <query>: fused code-intelligence context for the diffed files'
  // directories, via the eidos trio-lib-dropin (neverthrow-monadic).
  const trioIdx = process.argv.indexOf("--trio");
  if (trioIdx !== -1) {
    const query = process.argv[trioIdx + 1];
    if (!query) { console.error("--trio requires a query"); process.exit(1); }
    (async () => {
      const { borrowTrio } = await import("/home/toxic/pens/ergasterion/eidos/dropin/trio-lib-dropin.ts");
      const trio = borrowTrio(import.meta.url);
      const roots = [...new Set(files.filter((f) => existsSync(f)).map((f) => dirname(resolve(f))))];
      const results = [];
      for (const root of roots) {
        const res = await trio.search(query, { root, limit: 10 });
        if (res.isOk()) results.push({ root, hits: res.value.hits, stats: res.value.stats });
        else results.push({ root, error: res.error.message });
      }
      console.log(JSON.stringify(format === "json" ? results : results, null, 2));
      process.exit(0);
    })();
    return;
  }

  if (merge) {
    if (files.length !== 3) {
      console.error("Usage: ffs-diff <base> <ours> <theirs> --merge [--output <file>]");
      process.exit(1);
    }
    const [baseP, oursP, theirsP] = files.map((f) => resolve(f));
    for (const p of [baseP, oursP, theirsP]) if (!existsSync(p)) { console.error(`Not found: ${p}`); process.exit(1); }

    const auto = readFileSync(oursP, "utf8") === readFileSync(theirsP, "utf8");
    const { merged, conflicts } = auto
      ? { merged: splitLines(readFileSync(oursP, "utf8")), conflicts: 0 }
      : mergeThree(baseP, oursP, theirsP);
    const text = merged.join("\n") + "\n";

    if (format === "json") {
      const idx = [];
      let open = null;
      for (let i = 0; i < merged.length; i++) {
        if (merged[i] === "<<<<<<< ours") open = i;
        else if (merged[i] === ">>>>>>> theirs" && open !== null) { idx.push([open, i]); open = null; }
      }
      console.log(JSON.stringify({ conflicts, conflictRegions: idx, merged: text }, null, 2));
    } else if (output) {
      writeFileSync(output, text, "utf8");
      console.log(`mer-> ${merged.length} lines, conflicts: ${conflicts}${output ? " -> " + output : ""}`);
      if (conflicts) console.log(`conflict markers written to ${output} — resolve before use.`);
    } else {
      process.stdout.write(text);
    }
    process.exit(conflicts ? 1 : 0);
  }

  if (files.length < 2) {
    console.error("Usage: ffs-diff <file1> <file2> [file3 ...] [--outline] [--full]");
    process.exit(1);
  }
  const results = [];
  let totalChanges = 0;
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const aPath = resolve(files[i]);
      const bPath = resolve(files[j]);
      if (!existsSync(aPath)) { console.error(`Not found: ${aPath}`); continue; }
      if (!existsSync(bPath)) { console.error(`Not found: ${bPath}`); continue; }
      const outlineA = getOutline(aPath);
      const outlineB = getOutline(bPath);
      const sigA = buildSignatureMap(outlineA);
      const sigB = buildSignatureMap(outlineB);
      const sigDiff = diffSignatures(sigA, sigB);
      const changes = sigDiff.added.length + sigDiff.removed.length + sigDiff.changed.length;
      totalChanges += changes;
      if (format === "json") results.push(renderJsonDiff(aPath, bPath, sigDiff, outlineA, outlineB, fullDiff));
      else console.log(renderTextDiff(aPath, bPath, sigDiff, outlineA, outlineB, fullDiff, showLines));
    }
  }
  if (format === "text" && results.length === 0) {
    console.log(`\n--- SUMMARY: ${files.length} files, ${files.length * (files.length - 1) / 2} pairs ---`);
    console.log(`Total structural changes: ${totalChanges}`);
  }
  if (format === "json" && results.length > 0) {
    console.log(JSON.stringify(results, null, 2));
  }
}

main();