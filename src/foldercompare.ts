import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getOutline, buildSignatureMap } from "./outline.ts";

#!/usr/bin/env bun
"use strict";
/**
 * foldercompare — "find similar to this folder", with a cherry-pick goal.
 *
 * Given a target FOLDER and a list of candidate trees, every file in the
 * target is compared against every file in every candidate tree, ranked by
 * similarity, and the best source for each target file is reported so the
 * caller can cherry-pick the strongest variant into the target.
 *
 * Similarity is a blend of:
 *   - structural  : tree-sitter signature overlap (via perthite's outline)
 *   - lexical     : token-set Jaccard over identifiers/comments
 *   - semantic    : embedding cosine over bge-m3 (freeinference), optional
 *   - exact       : byte-identical shortcut
 *
 * Usage:
 *   node foldercompare.js --folder <targetDir> --against <dir> [<dir> ...]
 *                          [--json out.json] [--top N] [--semantic]
 *                          [--ext .go,.ts] [--min-score 0.35]
 */



const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", ".cache", "web", "frontend",
  "bin", "coverage", ".next", "target", "data", "testdata",
]);

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    folder: null, against: [], json: null, top: 5, semantic: false,
    exts: null, minScore: 0.25, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--folder") o.folder = argv[++i];
    else if (a === "--against") { const v = argv[++i]; if (v) o.against.push(v); }
    else if (a === "--json") o.json = argv[++i];
    else if (a === "--top") o.top = Number(argv[++i]);
    else if (a === "--semantic") o.semantic = true;
    else if (a === "--ext") o.exts = argv[++i].split(",").map((e) => e.trim());
    else if (a === "--min-score") o.minScore = Number(argv[++i]);
    else if (a === "--verbose") o.verbose = true;
  }
  return o;
}

// ── file walk ───────────────────────────────────────────────────────────────
function walk(root, exts) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (exts && !exts.some((x) => e.name.endsWith(x))) continue;
        files.push(full);
      }
    }
  }
  return files;
}

// ── lexical signature ──────────────────────────────────────────────────────
const STOP = new Set([
  "the", "a", "an", "and", "or", "if", "else", "for", "to", "of", "in", "on",
  "is", "it", "this", "that", "be", "are", "was", "were", "with", "as", "by",
  "at", "from", "not", "we", "you", "i", "s", "t", "e", "r", "n",
]);

function lexTokens(text) {
  const raw = text.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) || [];
  const set = new Set();
  for (const t of raw) {
    if (t.length < 3 || STOP.has(t)) continue;
    // split camelCase / snake_case into parts but keep the whole token
    set.add(t);
    for (const part of t.split("_")) {
      if (part.length >= 3 && !STOP.has(part)) set.add(part);
    }
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── structural signature ───────────────────────────────────────────────────
function structSig(file) {
  const sigs = buildSignatureMap(getOutline(file));
  const names = new Set();
  for (const k of Object.keys(sigs)) {
    const s = sigs[k];
    names.add(`${s.kind}:${s.name}`);
    if (s.signature) for (const m of s.signature.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) names.add(m[0]);
  }
  return names;
}

// ── semantic embeddings (bge-m3 via freeinference) ─────────────────────────
function embedBatch(texts, model = "bge-m3", endpoint = "https://freeinference.org/v1/embeddings") {
  const key = process.env.FREEINFERENCE_API_KEY;
  if (!key) throw new Error("FREEINFERENCE_API_KEY not set");
  const out = [];
  const BATCH = 8;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const r = spawnSync("curl", [
      "-sS", "-m", "120", "-X", "POST", endpoint,
      "-H", `Authorization: Bearer ${key}`,
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ model, input: slice, encoding_format: "float" }),
    ], { encoding: "utf8", timeout: 130000, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`curl embeddings: ${r.stderr}`);
    let j;
    try { j = JSON.parse(r.stdout); } catch (e) { throw new Error(`embeddings parse: ${e.message} :: ${r.stdout.slice(0, 200)}`); }
    const data = j.data || [];
    if (!data.length) throw new Error(`embeddings empty: ${r.stdout.slice(0, 200)}`);
    // preserve input order
    const byIdx = [...data].sort((a, b) => a.index - b.index);
    for (const d of byIdx) out.push(d.embedding);
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── main ────────────────────────────────────────────────────────────────────
function readSafe(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.folder || o.against.length === 0) {
    console.error("usage: foldercompare.js --folder <target> --against <dir> [<dir>...] [--json out] [--top N] [--semantic]");
    process.exit(2);
  }
  const folder = path.resolve(o.folder);
  const against = o.against.map((d) => path.resolve(d));

  const targetFiles = walk(folder, o.exts);
  const candidates = [];
  for (const root of against) {
    for (const f of walk(root, o.exts)) {
      candidates.push({ path: f, root, rel: path.relative(root, f).split(path.sep).join("/") });
    }
  }

  // Precompute signatures once per file.
  const targetMeta = targetFiles.map((f) => {
    const buf = readSafe(f);
    const text = buf ? buf.toString("utf8") : "";
    return {
      path: f, rel: path.relative(folder, f).split(path.sep).join("/"),
      buf, text, hash: buf ? crypto.createHash("sha1").update(buf).digest("hex") : "",
      lex: lexTokens(text), struct: structSig(f),
    };
  });
  const candMeta = candidates.map((c) => {
    const buf = readSafe(c.path);
    const text = buf ? buf.toString("utf8") : "";
    return {
      ...c, buf, text, hash: buf ? crypto.createHash("sha1").update(buf).digest("hex") : "",
      lex: lexTokens(text), struct: structSig(c.path),
    };
  });

  // Index candidates by basename for a fast prefilter, but keep a global pool
  // so cross-name matches (renamed files) can still surface.
  const byName = new Map();
  for (const c of candMeta) {
    const b = path.basename(c.path);
    if (!byName.has(b)) byName.set(b, []);
    byName.get(b).push(c);
  }

  let semTarget = null, semCand = null;
  if (o.semantic) {
    process.stderr.write(`[foldercompare] embedding ${targetMeta.length} target + ${candMeta.length} candidate files with bge-m3...\n`);
    const sample = (t) => (t.text.length > 6000 ? t.text.slice(0, 6000) : t.text);
    try {
      semTarget = embedBatch(targetMeta.map(sample));
      semCand = embedBatch(candMeta.map(sample));
      process.stderr.write(`[foldercompare] embeddings: ${semTarget.length} + ${semCand.length}\n`);
    } catch (e) {
      process.stderr.write(`[foldercompare] semantic stage skipped: ${e.message}\n`);
      semTarget = null; semCand = null;
    }
  }

  const results = [];
  for (let ti = 0; ti < targetMeta.length; ti++) {
    const t = targetMeta[ti];
    // candidates: same basename first, then same-directory-relpath matches,
    // then everything else (bounded to keep it tractable).
    const pool = [];
    const seenC = new Set();
    const push = (c) => { if (!seenC.has(c.path)) { seenC.add(c.path); pool.push(c); } };
    for (const c of byName.get(path.basename(t.path)) || []) push(c);
    for (const c of candMeta) {
      if (c.rel === t.rel) push(c);
    }
    // For rename detection, include candidates whose lexical similarity to the
    // target is non-trivial. Cap the pool.
    if (pool.length < o.top * 3) {
      for (const c of candMeta) {
        if (seenC.has(c.path)) continue;
        const lex = jaccard(t.lex, c.lex);
        if (lex > 0.45) push(c);
      }
    }

    const scored = [];
    for (const c of pool) {
      let score;
      let kind;
      if (t.hash && t.hash === c.hash) {
        score = 1; kind = "identical";
      } else {
        const lex = jaccard(t.lex, c.lex);
        const str = jaccard(t.struct, c.struct);
        let sem = 0;
        if (semTarget && semCand) {
          const ci = candMeta.indexOf(c);
          sem = cosine(semTarget[ti], semCand[ci]);
          // map cosine [-1,1] -> [0,1]
          sem = (sem + 1) / 2;
        }
        // Weights: structural is the strongest signal for code identity,
        // lexical second, semantic third (it is the fuzziest).
        score = sem > 0 ? 0.45 * str + 0.30 * lex + 0.25 * sem
                        : 0.60 * str + 0.40 * lex;
        kind = "variant";
      }
      if (score < o.minScore) continue;
      scored.push({
        source: c.path, sourceRoot: c.root, sourceRel: c.rel,
        score: +score.toFixed(4), kind,
        bytes: c.buf ? c.buf.length : 0,
        targetBytes: t.buf ? t.buf.length : 0,
        hash: c.hash,
      });
    }
    scored.sort((a, b) => b.score - a.score || b.bytes - a.bytes);
    if (scored.length) {
      results.push({
        target: t.rel,
        targetPath: t.path,
        targetBytes: t.buf ? t.buf.length : 0,
        best: scored[0],
        candidates: scored.slice(0, o.top),
      });
    }
  }

  const summary = {
    targetFiles: targetMeta.length,
    candidateFiles: candMeta.length,
    matchedTargets: results.length,
    identical: results.filter((r) => r.best.kind === "identical").length,
    improved: results.filter((r) => r.best.kind === "variant" && r.best.score > 0.9).length,
    semantic: !!semTarget,
  };

  const payload = { folder, against, summary, results };
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(payload, null, 2));

  console.log(`target: ${folder} (${summary.targetFiles} files)`);
  console.log(`against: ${against.join(", ")} (${summary.candidateFiles} files)`);
  console.log(`summary: ${JSON.stringify(summary)}`);
  console.log("\n-- per-target best source (cherry-pick candidates) --");
  for (const r of results.slice(0, 60)) {
    const b = r.best;
    console.log(
      `  ${(r.target + "").padEnd(58).slice(0, 58)} <- ${b.sourceRel.padEnd(52).slice(0, 52)} ${String(b.score).padEnd(7)} ${b.kind}`,
    );
  }
  if (results.length > 60) console.log(`  ... ${results.length - 60} more in JSON`);
  process.exit(0);
}

main();
