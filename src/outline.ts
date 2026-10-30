import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Structural outline extraction: ffs tree-sitter outlines for code, heading
 * trees for markdown, plus signature-map comparison for change surfacing.
 */


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FFS_BIN = process.env.FFS_BIN || `${ROOT}/bin/ffs`;

function runFFS(...args) {
  const r = spawnSync(FFS_BIN, args, { encoding: "utf8", timeout: 60000 });
  const stderr = (r.stderr || "").trim();
  if (r.error) throw new Error(`ffs ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffs ${args.join(" ")}: ${stderr || "non-zero exit " + r.status}`);
  return r.stdout || "";
}

function getMarkdownOutline(filePath) {
  try {
    const lines = readFileSync(filePath, "utf8").split("\n");
    const headings = [];
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("```")) { inCode = !inCode; continue; }
      if (inCode) continue;
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) headings.push({ kind: `h${m[1].length}`, name: m[2].trim(), signature: line.trim(), line: i + 1 });
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

export { runFFS, getMarkdownOutline, getOutline, buildSignatureMap, diffSignatures };