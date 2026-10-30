import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "bin", "perthite.ts");

function runMerge(base, ours, theirs) {
  const dir = mkdtempSync(join(tmpdir(), "ffsdiff-"));
  const b = join(dir, "base"); writeFileSync(b, base);
  const o = join(dir, "ours"); writeFileSync(o, ours);
  const t = join(dir, "theirs"); writeFileSync(t, theirs);
  const r = spawnSync("bun", [CLI, b, o, t, "--merge"], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("non-overlapping edits merge cleanly", () => {
  const { status, stdout } = runMerge("1\nA\n3\nB\n5\n", "1\nA-ours\n3\nB\n5\n", "1\nA\n3\nB-theirs\n5\n");
  expect(status).toBe(0);
  expect(stdout).toContain("A-ours");
  expect(stdout).toContain("B-theirs");
});

test("identical change on both sides merges clean, no conflict", () => {
  const { status, stdout } = runMerge("A\nB\n", "A-new\nB\n", "A-new\nB\n");
  expect(status).toBe(0);
  expect(stdout).toContain("A-new");
});

test("conflicting change on same line emits markers and exit 1", () => {
  const { status, stdout } = runMerge("base\nA\nend\n", "base\nA-ours\nend\n", "base\nA-theirs\nend\n");
  expect(status).toBe(1);
  expect(stdout).toContain("<<<<<<<");
  expect(stdout).toContain("=======");
  expect(stdout).toContain(">>>>>>>");
  expect(stdout).toContain("A-ours");
  expect(stdout).toContain("A-theirs");
});

test("help exits 0", () => {
  const r = spawnSync("bun", [CLI, "--help"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("--merge");
});