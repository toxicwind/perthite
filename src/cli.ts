/**
 * CLI parsing, help text, and output formatting for perthite.
 * Dispatch lives in bin/perthite.js.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { splitLines, simpleDiff } from "./diff";
import { getOutline, buildSignatureMap, diffSignatures } from "./outline";
import { mergeThree, fastForward } from "./merge";


const HELP = `Usage:
  perthite <file1> <file2> [--format json|text] [--outline] [--full]
      Structural diff of two files (added/removed/changed symbols, outlines).

  perthite <base> <ours> <theirs> --merge [--output <file>] [--json]
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
`;

function parseArgs(argv) {
  const files = [];
  const opts = { format: "text", outlineOnly: false, fullDiff: false, showLines: false, merge: false, output: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") { opts.help = true; continue; }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (key === "format" && next) { opts.format = next; i++; }
      else if (key === "outline") opts.outlineOnly = true;
      else if (key === "full") opts.fullDiff = true;
      else if (key === "lines") opts.showLines = true;
      else if (key === "merge") opts.merge = true;
      else if (key === "output" && next) { opts.output = next; i++; }
      else if (key === "help") opts.help = true;
    } else if (arg) {
      files.push(arg);
    }
  }
  return { files, ...opts };
}

function renderTextDiff(aPath, bPath, sigDiff, outlineA, outlineB, fullDiff) {
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
        for (const line of simpleDiff(textA, textB, 80).slice(0, 80)) {
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
  return {
    file1: aPath, file2: bPath,
    outline1: outlineA.length, outline2: outlineB.length,
    structural: sigDiff,
    diff: { changed: textA !== textB, lines: simpleDiff(textA, textB, 80) },
  };
}

function runDiff(files, opts) {
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
      totalChanges += sigDiff.added.length + sigDiff.removed.length + sigDiff.changed.length;
      if (opts.format === "json") results.push(renderJsonDiff(aPath, bPath, sigDiff, outlineA, outlineB, opts.fullDiff));
      else console.log(renderTextDiff(aPath, bPath, sigDiff, outlineA, outlineB, opts.fullDiff));
    }
  }
  if (opts.format === "text" && results.length === 0) {
    console.log(`\n--- SUMMARY: ${files.length} files, ${files.length * (files.length - 1) / 2} pairs ---`);
    console.log(`Total structural changes: ${totalChanges}`);
  }
}

function runMerge(files, opts) {
  const [baseP, oursP, theirsP] = files.map((f) => resolve(f));
  for (const p of [baseP, oursP, theirsP]) if (!existsSync(p)) { console.error(`Not found: ${p}`); process.exit(1); }

  const baseT = readFileSync(baseP, "utf8");
  const oursT = readFileSync(oursP, "utf8");
  const theirsT = readFileSync(theirsP, "utf8");
  const ff = fastForward(baseT, oursT, theirsT);
  const { merged, conflicts } = ff ? ff : mergeThree(baseP, oursP, theirsP);
  const text = merged.join("\n") + "\n";

  if (opts.format === "json") {
    const idx = [];
    let open = null;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] === "<<<<<<< ours") open = i;
      else if (merged[i].startsWith(">>>>>>>") && open !== null) { idx.push([open, i]); open = null; }
    }
    console.log(JSON.stringify({ conflicts, conflictRegions: idx, merged: text }, null, 2));
  } else if (opts.output) {
    writeFileSync(opts.output, text, "utf8");
    console.log(`-> ${merged.length} lines, conflicts: ${conflicts} -> ${opts.output}`);
    if (conflicts) console.log(`conflict markers present — resolve before use.`);
  } else {
    process.stdout.write(text);
  }
  return conflicts;
}

module.exports = { HELP, parseArgs, runDiff, runMerge };