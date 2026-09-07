import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check-roadmap.mjs");
const TODAY = "2026-09-07";

// Write a fixture repo into a temp dir. `files` maps relative path -> content.
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "roadmap-check-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function run(dir, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--root", dir, "--today", TODAY, ...extra], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const plan = (status, date = "2026-09-01", extra = "") =>
  `---\ntitle: X\ntype: plan\nstatus: ${status}\ndate: ${date}\n${extra}---\n\nbody\n`;

test("clean repo passes with a summary line", () => {
  const dir = repo({
    "ROADMAP.md": "# Roadmap\n\n- [ ] do the thing (2026-09-01)\n- [ ] [plan](docs/plans/a.md) : decided (2026-09-05)\n- [x] done thing (2026-08-01)\n",
    "docs/plans/a.md": plan("decided"),
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 open lines, 1 linked plans, 1 plan files scanned, no drift/);
});

test("rule 1: a link to a missing plan fails", () => {
  const dir = repo({ "ROADMAP.md": "- [ ] see docs/plans/missing.md (2026-09-01)\n" });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /does not exist: docs\/plans\/missing\.md/);
});

test("rule 2: an open line linking a completed plan fails", () => {
  const dir = repo({
    "ROADMAP.md": "- [ ] [plan](docs/plans/a.md) (2026-09-01)\n",
    "docs/plans/a.md": plan("completed"),
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /open roadmap line links plan with status "completed"/);
});

test("rule 3: a decided plan nobody links fails; one referenced by a linked plan passes", () => {
  const orphan = repo({
    "ROADMAP.md": "- [ ] something else (2026-09-01)\n",
    "docs/plans/a.md": plan("decided"),
  });
  assert.equal(run(orphan).code, 1);
  assert.match(run(orphan).out, /plan is "decided" but no open roadmap line/);

  const viaPlan = repo({
    "ROADMAP.md": "- [ ] [umbrella](docs/plans/umbrella.md) (2026-09-01)\n",
    "docs/plans/umbrella.md": plan("in-progress", "2026-09-01", "") + "\nsee docs/plans/child.md\n",
    "docs/plans/child.md": plan("decided"),
  });
  const r = run(viaPlan);
  assert.equal(r.code, 0, r.out);
});

test("rule 3: live plans with no ROADMAP.md fail; no roadmap and no live plan is a notice", () => {
  const live = repo({ "docs/plans/a.md": plan("in-progress") });
  const r1 = run(live);
  assert.equal(r1.code, 1);
  assert.match(r1.out, /no ROADMAP\.md to index it/);

  const quiet = repo({ "docs/plans/a.md": plan("completed"), "README.md": "hi\n" });
  const r2 = run(quiet);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /not adopted/);
});

test("rule 4: an open line without a date fails; ticked lines need none", () => {
  const dir = repo({ "ROADMAP.md": "- [ ] undated thing\n- [x] old done thing\n" });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /ROADMAP\.md:1: open roadmap line has no last-confirmed date/);
  assert.doesNotMatch(r.out, /ROADMAP\.md:2/);
});

test("rule 5: a stale open line fails at the default 30 days and passes with a larger --max-age or a bump", () => {
  const stale = repo({ "ROADMAP.md": "- [ ] stale thing (2026-07-01)\n" });
  const r = run(stale);
  assert.equal(r.code, 1);
  assert.match(r.out, /last confirmed 68 days ago \(2026-07-01\), limit is 30/);
  assert.equal(run(stale, ["--max-age", "90"]).code, 0);

  const bumped = repo({ "ROADMAP.md": "- [ ] stale thing (2026-07-01) re-confirmed (2026-09-06)\n" });
  assert.equal(run(bumped).code, 0, "the last date token wins");
});

test("rule 5: the date may sit on a continuation line of a wrapped item", () => {
  const dir = repo({
    "ROADMAP.md": "- [ ] a long item that wraps onto\n      a second line (2026-09-01)\n- [ ] next (2026-09-01)\n",
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 open lines/);
});

test("rule 5: an unlinked draft older than --max-age fails; linked from an open line it does not age on its own", () => {
  const old = repo({
    "ROADMAP.md": "- [ ] unrelated (2026-09-01)\n",
    "docs/plans/old.md": plan("draft", "2026-06-01"),
  });
  const r = run(old);
  assert.equal(r.code, 1);
  assert.match(r.out, /unlinked draft plan is 98 days old/);

  const linked = repo({
    "ROADMAP.md": "- [ ] [old](docs/plans/old.md) (2026-09-01)\n",
    "docs/plans/old.md": plan("draft", "2026-06-01"),
  });
  assert.equal(run(linked).code, 0);
});

test("rule 6: an unknown status fails; missing status reads as draft; neither status nor date fails", () => {
  const bad = repo({ "ROADMAP.md": "- [ ] x (2026-09-01)\n", "docs/plans/a.md": plan("open") });
  assert.match(run(bad).out, /plan status "open" is not one of/);

  const noStatus = repo({
    "ROADMAP.md": "- [ ] x (2026-09-01)\n",
    "docs/plans/a.md": "---\ntitle: A\ntype: plan\ndate: 2026-09-01\n---\n",
  });
  assert.equal(run(noStatus).code, 0, run(noStatus).out);

  const nothing = repo({
    "ROADMAP.md": "- [ ] x (2026-09-01)\n",
    "docs/plans/a.md": "---\ntitle: A\ntype: plan\n---\n",
  });
  assert.match(run(nothing).out, /neither status nor date/);
});

test("exempt types under a plan folder are never checked", () => {
  const dir = repo({
    "ROADMAP.md": "- [ ] x (2026-09-01)\n",
    "docs/plans/handover.md": "---\ntype: handover\n---\nno status, no date\n",
    "docs/plans/README.md": "---\ntype: readme\n---\n",
    "docs/plans/notes.md": "---\ntype: documentation\nstatus: whatever\n---\n",
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
});

test("plans are discovered in all six default folders and a date in the filename counts", () => {
  const dir = repo({
    "ROADMAP.md": "- [ ] [sp](docs/superpowers/plans/2026-09-01-sp.md) (2026-09-01)\n",
    "docs/superpowers/plans/2026-09-01-sp.md": "---\ntype: plan\nstatus: decided\n---\n",
    "docs/decisions/2026-09-02-adr.md": "---\ntype: plan\nstatus: draft\n---\n",
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 plan files scanned/);
});

test("prose-only roadmaps are ignored except for links", () => {
  const dir = repo({
    "ROADMAP.md": "# Roadmap\n\n## Shipped\n\n- **thing** shipped 2026-01-01\n\n| a | b |\n|---|---|\n| c | d |\n\nSee docs/plans/a.md for context.\n",
    "docs/plans/a.md": plan("completed"),
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 open lines/);
});

test("--plans-dir overrides the default set", () => {
  const dir = repo({
    "ROADMAP.md": "- [ ] [p](plans/a.md) (2026-09-01)\n",
    "plans/a.md": plan("decided"),
    "docs/plans/ignored.md": plan("in-progress"),
  });
  assert.equal(run(dir, ["--plans-dir", "plans"]).code, 0);
  assert.equal(run(dir).code, 1, "with the defaults the unlinked in-progress plan under docs/plans is caught");
});

test("usage errors exit 2", () => {
  const dir = repo({});
  assert.equal(run(dir, ["--max-age", "soon"]).code, 2);
  assert.equal(run(dir, ["--bogus"]).code, 2);
});

test("a --root that does not exist is a usage error, never a silent 'not adopted'", () => {
  const r = run(join(tmpdir(), "roadmap-check-does-not-exist-" + Date.now()));
  assert.equal(r.code, 2);
  assert.match(r.out, /does not exist/);
});
