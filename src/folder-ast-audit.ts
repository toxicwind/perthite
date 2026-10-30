import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getOutline, buildSignatureMap, diffSignatures } from "./outline.ts";

#!/usr/bin/env bun
"use strict";
/**
 * folder-ast-audit — structural comparison of two source trees.
 *
 * Reuses perthite's outline/signature machinery (tree-sitter via the `ffs`
 * binary) to classify every file pair between two folders:
 *   identical      — byte-for-byte equal
 *   restyled       — same structural signature, different body
 *   divergent      — same file, different structure
 *   only-in-a/b    — present on one side only
 *
 * Usage: node folder-ast-audit.js <dirA> <dirB> [--json out.json] [--ext .go,.ts]
 */



const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", ".cache", "web", "frontend",
  "bin", "coverage", ".next", "target", "vendor.old-20261023", "data",
]);

function parseArgs(argv) {
  const out = { dirs: [], json: null, exts: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = argv[++i];
    else if (a === "--ext") out.exts = argv[++i].split(",").map((e) => e.trim());
    else if (a === "--quiet") out.quiet = true;
    else out.dirs.push(a);
  }
  return out;
}

function walk(root, exts) {
  const files = new Map(); // relpath -> abspath
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (exts && !exts.some((x) => e.name.endsWith(x))) continue;
        files.set(path.relative(root, full), full);
      }
    }
  }
  return files;
}

function rel(r) {
  return r.split(path.sep).join("/");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dirs.length < 2) {
    console.error("usage: folder-ast-audit.js <dirA> <dirB> [--json out.json] [--ext .go,.ts]");
    process.exit(2);
  }
  const [aRoot, bRoot] = opts.dirs.map((d) => path.resolve(d));
  const exts = opts.exts || null;

  const aFiles = walk(aRoot, exts);
  const bFiles = walk(bRoot, exts);

  const result = {
    a: { root: aRoot, count: aFiles.size },
    b: { root: bRoot, count: bFiles.size },
    identical: [],
    restyled: [],
    divergent: [],
    onlyInA: [],
    onlyInB: [],
    identicalBytes: 0,
    restyledBytes: 0,
    divergentBytes: 0,
  };

  const relA = new Map([...aFiles].map(([k, v]) => [rel(k), v]));
  const relB = new Map([...bFiles].map(([k, v]) => [rel(k), v]));

  for (const [r, aPath] of relA) {
    if (!relB.has(r)) {
      result.onlyInA.push(r);
      continue;
    }
    const bPath = relB.get(r);
    const aBuf = fs.readFileSync(aPath);
    const bBuf = fs.readFileSync(bPath);
    if (aBuf.equals(bBuf)) {
      result.identical.push(r);
      result.identicalBytes += aBuf.length;
      continue;
    }
    const oa = buildSignatureMap(getOutline(aPath));
    const ob = buildSignatureMap(getOutline(bPath));
    const d = diffSignatures(oa, ob);
    const structural =
      d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
    const entry = {
      file: r,
      aBytes: aBuf.length,
      bBytes: bBuf.length,
      added: d.added.length,
      removed: d.removed.length,
      changed: d.changed.length,
      aSymbols: Object.keys(oa).length,
      bSymbols: Object.keys(ob).length,
    };
    if (structural) {
      result.restyled.push(entry);
      result.restyledBytes += aBuf.length;
    } else {
      result.divergent.push(entry);
      result.divergentBytes += aBuf.length;
    }
  }
  for (const [r] of relB) if (!relA.has(r)) result.onlyInB.push(r);

  result.summary = {
    identical: result.identical.length,
    restyled: result.restyled.length,
    divergent: result.divergent.length,
    onlyInA: result.onlyInA.length,
    onlyInB: result.onlyInB.length,
    identicalPct: +((100 * result.identical.length) / Math.max(1, result.identical.length + result.restyled.length + result.divergent.length)).toFixed(1),
  };

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify(result, null, 2));
  }
  if (!opts.quiet) {
    console.log(`A: ${aRoot} (${aFiles.size} files)`);
    console.log(`B: ${bRoot} (${bFiles.size} files)`);
    console.log(`\nsummary: ${JSON.stringify(result.summary)}`);
    console.log(`identical ${result.identicalBytes}B | restyled ${result.restyledBytes}B | divergent ${result.divergentBytes}B`);
    if (result.divergent.length) {
      console.log(`\n-- structurally divergent (${result.divergent.length}) --`);
      for (const d of result.divergent.slice(0, 40))
        console.log(`  ${d.file}  +${d.added} -${d.removed} ~${d.changed}  (${d.aSymbols}->${d.bSymbols} syms)`);
    }
    if (result.restyled.length) {
      console.log(`\n-- restyled, same structure (${result.restyled.length}) --`);
      for (const d of result.restyled.slice(0, 20)) console.log(`  ${d.file}`);
    }
    if (result.onlyInA.length) {
      console.log(`\n-- only in A (${result.onlyInA.length}) --`);
      for (const f of result.onlyInA.slice(0, 30)) console.log(`  ${f}`);
    }
    if (result.onlyInB.length) {
      console.log(`\n-- only in B (${result.onlyInB.length}) --`);
      for (const f of result.onlyInB.slice(0, 30)) console.log(`  ${f}`);
    }
  }
  process.exit(0);
}

main();
