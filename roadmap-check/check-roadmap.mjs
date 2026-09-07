#!/usr/bin/env node
/**
 * roadmap-check
 *
 * The root ROADMAP.md is the ONLY index of open work in a repo; plan files are
 * the only place content lives. This script keeps the two from drifting.
 *
 * Rules enforced (a violation fails the run):
 *   1. Every plan link on the roadmap points at a file that exists.
 *   2. An open roadmap line (`- [ ]`) never links a plan whose status is
 *      completed, archived or rejected.
 *   3. A plan with status decided or in-progress is linked from at least one
 *      open roadmap line, or referenced by a plan that is. A plan nobody
 *      indexes is a bin, not a plan.
 *   4. Every open roadmap line carries a last-confirmed date `(YYYY-MM-DD)`.
 *   5. An open line whose date is older than --max-age days fails; an unlinked
 *      draft plan whose frontmatter date is older than --max-age days fails.
 *   6. A plan's `status`, when present, is one of draft, decided, in-progress,
 *      completed, archived, rejected. A missing status is read as draft. A plan
 *      with neither status nor date fails (it cannot be aged).
 *
 * Scoping:
 *   - Only checkbox lines (`- [ ]`, `- [x]`) are items. Prose, headings and
 *     tables are ignored, so a roadmap in another style needs no rewrite.
 *   - Rules 3, 5 and 6 apply to files whose frontmatter has `type: plan` or no
 *     type. handover, documentation, readme, roadmap and changelog are exempt.
 *   - A repo with no ROADMAP.md and no live plan is skipped with a notice. A
 *     repo with live plans and no ROADMAP.md fails rule 3.
 *
 * Usage:
 *   check-roadmap.mjs [--root DIR] [--roadmap ROADMAP.md] [--max-age 30]
 *                     [--plans-dir DIR ...] [--today YYYY-MM-DD]
 *
 * Exit codes: 0 no drift, 1 drift, 2 usage error.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DEFAULT_PLAN_DIRS = [
  "docs/plans",
  "plans",
  "docs/superpowers",
  "docs/specs",
  "docs/research",
  "docs/decisions",
];
const LIFECYCLE = new Set(["draft", "decided", "in-progress", "completed", "archived", "rejected"]);
const TERMINAL = new Set(["completed", "archived", "rejected"]);
const LIVE = new Set(["decided", "in-progress"]);
const EXEMPT_TYPES = new Set(["handover", "documentation", "readme", "roadmap", "changelog"]);
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- arguments
function usage(msg) {
  if (msg) console.error(`roadmap-check: ${msg}\n`);
  console.error(
    "usage: check-roadmap.mjs [--root DIR] [--roadmap FILE] [--max-age DAYS] [--plans-dir DIR ...] [--today YYYY-MM-DD]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), roadmap: "ROADMAP.md", maxAge: 30, plansDirs: [], today: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") opts.root = resolve(next());
    else if (a === "--roadmap") opts.roadmap = next();
    else if (a === "--max-age") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 0) usage("--max-age must be a non-negative integer");
      opts.maxAge = n;
    } else if (a === "--plans-dir") {
      for (const d of next().split(/[\s,]+/)) if (d) opts.plansDirs.push(d.replace(/\/+$/, ""));
    } else if (a === "--today") {
      const t = next();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) usage("--today must be YYYY-MM-DD");
      opts.today = t;
    } else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument ${a}`);
  }
  if (opts.plansDirs.length === 0) opts.plansDirs = DEFAULT_PLAN_DIRS;
  return opts;
}

// ------------------------------------------------------------------ helpers
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function dateFrom(str) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(str ?? "");
  return m ? m[1] : null;
}

function ageDays(date, today) {
  return Math.floor((Date.parse(today) - Date.parse(date)) / DAY_MS);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// -------------------------------------------------------------------- plans
function loadPlans(root, plansDirs) {
  const plans = new Map(); // relative path -> record
  for (const dir of plansDirs) {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const file of walk(abs)) {
      const rel = relative(root, file).split("\\").join("/");
      const text = readFileSync(file, "utf8");
      const fm = frontmatter(text);
      const type = (fm.type ?? "").toLowerCase();
      const isPlan = type === "" || type === "plan";
      const status = fm.status ? fm.status.toLowerCase() : null;
      const date = dateFrom(fm.date) ?? dateFrom(rel.split("/").pop());
      plans.set(rel, { rel, text, type, isPlan, status, date, exempt: EXEMPT_TYPES.has(type) });
    }
  }
  return plans;
}

// ------------------------------------------------------------------ roadmap
function parseRoadmap(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^\s*[-*+] \[( |x|X)\] /.exec(line);
    if (!m) continue;
    const open = m[1] === " ";
    const body = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() !== "" &&
      !/^\s*[-*+] /.test(lines[j]) &&
      !/^#/.test(lines[j]) &&
      !/^\s*\|/.test(lines[j]) &&
      !/^\s*(```|~~~)/.test(lines[j])
    ) {
      body.push(lines[j]);
      j++;
    }
    items.push({ line: i + 1, open, text: body.join("\n") });
  }
  return { lines, items };
}

// --------------------------------------------------------------------- main
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const root = opts.root;
  const roadmapPath = join(root, opts.roadmap);
  const plans = loadPlans(root, opts.plansDirs);
  const problems = [];
  const annotate = process.env.GITHUB_ACTIONS === "true";
  const fail = (file, line, msg) => problems.push({ file, line, msg });

  const livePlans = [...plans.values()].filter((p) => p.isPlan && p.status && LIVE.has(p.status));

  if (!existsSync(roadmapPath)) {
    if (livePlans.length === 0) {
      console.log(`roadmap-check: no ${opts.roadmap} and no live plan in ${root}; nothing to check (not adopted)`);
      return 0;
    }
    for (const p of livePlans) {
      fail(p.rel, 1, `plan is "${p.status}" but the repo has no ${opts.roadmap} to index it (add the roadmap and link the plan)`);
    }
    return report(problems, annotate, { open: 0, linked: 0, plans: plans.size });
  }

  const roadmapText = readFileSync(roadmapPath, "utf8");
  const { lines, items } = parseRoadmap(roadmapText);

  // Link pattern: any of the plan dirs, longest first, not preceded by a path char.
  const dirAlt = [...opts.plansDirs].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const linkRe = new RegExp(`(?<![\\w./-])(?:\\./)?(?:${dirAlt})/[^\\s)\\]>"'\`]+?\\.md`, "g");
  const norm = (link) => link.replace(/^\.\//, "");

  // Rule 1: every link anywhere on the roadmap exists.
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(linkRe)) {
      const rel = norm(m[0]);
      if (!existsSync(join(root, rel))) {
        fail(opts.roadmap, idx + 1, `roadmap links a plan that does not exist: ${rel}`);
      }
    }
  });

  // Rules 2, 4, 5 on open items.
  const linked = new Set();
  let openCount = 0;
  for (const item of items) {
    if (!item.open) continue;
    openCount++;
    for (const m of item.text.matchAll(linkRe)) {
      const rel = norm(m[0]);
      const plan = plans.get(rel);
      if (!plan) continue; // rule 1 already reported it, or it is outside the plan dirs
      linked.add(rel);
      if (plan.status && TERMINAL.has(plan.status)) {
        fail(opts.roadmap, item.line, `open roadmap line links plan with status "${plan.status}": ${rel} (tick the line or reopen the plan)`);
      }
    }
    const dates = [...item.text.matchAll(/\((\d{4}-\d{2}-\d{2})\)/g)];
    if (dates.length === 0) {
      fail(opts.roadmap, item.line, `open roadmap line has no last-confirmed date; end it with (${today})`);
      continue;
    }
    const date = dates[dates.length - 1][1];
    const age = ageDays(date, today);
    if (Number.isNaN(age)) {
      fail(opts.roadmap, item.line, `open roadmap line has an unparseable date (${date})`);
    } else if (age > opts.maxAge) {
      fail(opts.roadmap, item.line, `open roadmap line last confirmed ${age} days ago (${date}), limit is ${opts.maxAge}: do it, drop it, or re-confirm it with (${today})`);
    }
  }

  // Rules 3, 5b, 6 on plans.
  const linkedBodies = [...linked].map((rel) => plans.get(rel)?.text ?? "");
  const referencedByLinkedPlan = (rel) => {
    const base = rel.split("/").pop();
    return linkedBodies.some((body) => body.includes(rel) || body.includes(base));
  };
  for (const p of plans.values()) {
    if (!p.isPlan) continue;
    if (p.status && !LIFECYCLE.has(p.status)) {
      fail(p.rel, 1, `plan status "${p.status}" is not one of ${[...LIFECYCLE].join(", ")}`);
      continue;
    }
    if (!p.status && !p.date) {
      fail(p.rel, 1, "plan has neither status nor date; add both (a missing status reads as draft, and a draft must be ageable)");
      continue;
    }
    const status = p.status ?? "draft";
    if (LIVE.has(status)) {
      if (!linked.has(p.rel) && !referencedByLinkedPlan(p.rel)) {
        fail(p.rel, 1, `plan is "${status}" but no open roadmap line (or plan linked from one) references it`);
      }
    } else if (status === "draft" && !linked.has(p.rel) && !referencedByLinkedPlan(p.rel)) {
      if (!p.date) {
        fail(p.rel, 1, "unlinked draft plan has no date and cannot be aged; add date: YYYY-MM-DD");
      } else {
        const age = ageDays(p.date, today);
        if (age > opts.maxAge) {
          fail(p.rel, 1, `unlinked draft plan is ${age} days old (${p.date}), limit is ${opts.maxAge}: link it from an open roadmap line, decide it, or archive it`);
        }
      }
    }
  }

  return report(problems, annotate, { open: openCount, linked: linked.size, plans: plans.size });
}

function report(problems, annotate, counts) {
  if (problems.length) {
    console.error("roadmap-check: the roadmap and the plans disagree\n");
    for (const p of problems) {
      console.error(`  - ${p.file}:${p.line}: ${p.msg}`);
      if (annotate) console.log(`::error file=${p.file},line=${p.line}::${p.msg}`);
    }
    console.error(`\n${problems.length} problem(s)`);
    return 1;
  }
  console.log(
    `roadmap-check: ${counts.open} open lines, ${counts.linked} linked plans, ${counts.plans} plan files scanned, no drift`,
  );
  return 0;
}

process.exit(main());
