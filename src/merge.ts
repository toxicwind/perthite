/**
 * Three-way merge (diff3) backed by git's battle-tested `merge-file`.
 * Never silently drops either side's edit; overlaps become conflict markers.
 */


/**
 * Merge base/ours/theirs (file paths). Returns { merged: string[], conflicts: number }.
 * - one-side change        -> taken verbatim
 * - identical change       -> taken once
 * - both sides diverge     -> <<<<<<< ours / ======= / >>>>>>> theirs (conflict++)
 */
function mergeThree(basePath, oursPath, theirsPath) {
  const r = spawnSync("git", ["merge-file", "-p", oursPath, basePath, theirsPath], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw new Error(`git merge-file: ${r.error.message}`);
  const text = (r.stdout || "").replace(/\n$/, "") + "\n";
  const lines = splitLines(text);
  let conflicts = 0;
  for (const ln of lines) if (ln.startsWith("<<<<<<<")) conflicts++;
  return { merged: lines, conflicts };
}

/** True when both revisions agree -> trivially clean, take either. */
function fastForward(baseText, oursText, theirsText) {
  if (oursText === theirsText) return { merged: splitLines(oursText), conflicts: 0, auto: true };
  if (oursText === baseText) return { merged: splitLines(theirsText), conflicts: 0, auto: true };
  if (theirsText === baseText) return { merged: splitLines(oursText), conflicts: 0, auto: true };
  return null;
}

export { mergeThree, fastForward };