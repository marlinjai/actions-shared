import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, globToRegExp, makeApi } from "../ci-gate.mjs";

const REPO = "o/r";
const DOCS = "docs/**\n**/*.md\nROADMAP.md";

// A fake GitHub API: `routes` maps a path (without the API base) to a JSON
// body, or to a number for an error status. Unknown paths answer 404.
function fakeApi(routes) {
  const seen = [];
  const fetchImpl = async (url) => {
    const path = url.replace("https://api.github.com", "");
    seen.push(path);
    const body = routes[path];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof body === "number") return { ok: false, status: body, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { api: makeApi({ token: "t", fetchImpl }), seen };
}

const prEvent = { pull_request: { number: 7 }, ref: "refs/pull/7/merge" };
const prFiles = (names) => ({ [`/repos/${REPO}/pulls/7/files?per_page=100&page=1`]: names.map((filename) => ({ filename })) });

test("globs: segment, cross-segment, zero-segment and literal dots", () => {
  assert.ok(globToRegExp("docs/**").test("docs/plans/a.md"));
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("**/*.md").test("apps/x/README.md"));
  assert.ok(!globToRegExp("*.md").test("apps/README.md"));
  assert.ok(!globToRegExp("**/*.md").test("apps/readme.mdx"));
  assert.ok(globToRegExp("apps/*/Dockerfile").test("apps/service/Dockerfile"));
  assert.ok(!globToRegExp("apps/*/Dockerfile").test("apps/a/b/Dockerfile"));
  assert.ok(globToRegExp("pnpm-lock.yaml").test("pnpm-lock.yaml"));
  assert.ok(!globToRegExp("pnpm-lock.yaml").test("pnpm-lockXyaml"));
});

test("docs-only pull request skips the heavy jobs", async () => {
  const { api } = fakeApi(prFiles(["docs/plans/a.md", "ROADMAP.md", "apps/x/README.md"]));
  const r = await decide({ api, repo: REPO, eventName: "pull_request", event: prEvent, ignore: DOCS });
  assert.equal(r.heavy, false);
});

test("a pull request with one code file runs in full", async () => {
  const { api } = fakeApi(prFiles(["docs/plans/a.md", "apps/x/src/index.ts"]));
  const r = await decide({ api, repo: REPO, eventName: "pull_request", event: prEvent, ignore: DOCS });
  assert.equal(r.heavy, true);
});

test("only-paths: runs when a file matches, skips when none does", async () => {
  const only = "apps/*/Dockerfile\npnpm-lock.yaml";
  const hit = fakeApi(prFiles(["apps/service/Dockerfile", "apps/service/src/a.ts"]));
  assert.equal((await decide({ api: hit.api, repo: REPO, eventName: "pull_request", event: prEvent, only })).heavy, true);
  const miss = fakeApi(prFiles(["apps/service/src/a.ts"]));
  assert.equal((await decide({ api: miss.api, repo: REPO, eventName: "pull_request", event: prEvent, only })).heavy, false);
});

test("only-paths and ignore-paths combine: a package README alone skips", async () => {
  const only = "packages/**";
  const readme = fakeApi(prFiles(["packages/core/README.md"]));
  assert.equal((await decide({ api: readme.api, repo: REPO, eventName: "pull_request", event: prEvent, only, ignore: DOCS })).heavy, false);
  const code = fakeApi(prFiles(["packages/core/README.md", "packages/core/src/a.ts"]));
  assert.equal((await decide({ api: code.api, repo: REPO, eventName: "pull_request", event: prEvent, only, ignore: DOCS })).heavy, true);
});

test("an empty or unreadable change list runs in full", async () => {
  const empty = fakeApi(prFiles([]));
  assert.equal((await decide({ api: empty.api, repo: REPO, eventName: "pull_request", event: prEvent, ignore: DOCS })).heavy, true);
  const push = { ref: "refs/heads/feature", before: "0000000000000000000000000000000000000000", after: "abc" };
  const created = fakeApi({});
  assert.equal((await decide({ api: created.api, repo: REPO, eventName: "push", event: push, ignore: DOCS })).heavy, true);
});

test("a pull request with more than 3000 files cannot be judged and runs in full", async () => {
  const routes = {};
  for (let p = 1; p <= 30; p++) {
    routes[`/repos/${REPO}/pulls/7/files?per_page=100&page=${p}`] = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${p}-${i}.md` }));
  }
  const { api } = fakeApi(routes);
  assert.equal((await decide({ api, repo: REPO, eventName: "pull_request", event: prEvent, ignore: DOCS })).heavy, true);
});

// A push to main from pull request #7: head H, pushed commit S with parent P.
function pushRoutes({ headTree = "T", pushedTree = "T", compareStatus = "ahead", passed = true, merged = true } = {}) {
  return {
    [`/repos/${REPO}/compare/P...S`]: { files: [{ filename: "apps/x/src/index.ts" }] },
    [`/repos/${REPO}/commits/S/pulls`]: merged ? [{ number: 7, merged_at: "2026-09-24T10:00:00Z", head: { sha: "H" } }] : [],
    [`/repos/${REPO}/commits/S`]: { parents: [{ sha: "P" }], commit: { tree: { sha: pushedTree } } },
    [`/repos/${REPO}/git/commits/H`]: { tree: { sha: headTree } },
    [`/repos/${REPO}/compare/P...H`]: { status: compareStatus },
    [`/repos/${REPO}/actions/runs/99`]: { workflow_id: 5 },
    [`/repos/${REPO}/actions/workflows/5/runs?event=pull_request&head_sha=H&status=success&per_page=1`]: {
      workflow_runs: passed ? [{ id: 42 }] : [],
    },
  };
}
const pushEvent = { ref: "refs/heads/main", before: "P", after: "S" };
const pushArgs = (api) => ({ api, repo: REPO, eventName: "push", event: pushEvent, runId: "99", defaultBranch: "main", ignore: DOCS, skipVerifiedPush: true });

test("verified push: same tree, main unchanged, pull request run passed: skip", async () => {
  const { api } = fakeApi(pushRoutes());
  const r = await decide(pushArgs(api));
  assert.equal(r.heavy, false);
  assert.match(r.reason, /#7 already passed on the same tree \(run 42\)/);
});

test("push after main moved underneath the pull request runs in full", async () => {
  const { api } = fakeApi(pushRoutes({ compareStatus: "diverged" }));
  const r = await decide(pushArgs(api));
  assert.equal(r.heavy, true);
  assert.match(r.reason, /main moved/);
});

test("push whose tree differs from the pull request head runs in full", async () => {
  const { api } = fakeApi(pushRoutes({ pushedTree: "T2" }));
  assert.equal((await decide(pushArgs(api))).heavy, true);
});

test("push without a passing pull request run runs in full", async () => {
  const { api } = fakeApi(pushRoutes({ passed: false }));
  assert.equal((await decide(pushArgs(api))).heavy, true);
});

test("direct push with no merged pull request runs in full", async () => {
  const { api } = fakeApi(pushRoutes({ merged: false }));
  const r = await decide(pushArgs(api));
  assert.equal(r.heavy, true);
  assert.match(r.reason, /no merged pull request/);
});

test("push to another branch never uses the verified-push shortcut", async () => {
  const { api, seen } = fakeApi(pushRoutes());
  const r = await decide({ ...pushArgs(api), event: { ...pushEvent, ref: "refs/heads/feature" } });
  assert.equal(r.heavy, true);
  assert.ok(!seen.some((p) => p.includes("/pulls")));
});

test("docs-only push to main skips before any verification call", async () => {
  const routes = pushRoutes();
  routes[`/repos/${REPO}/compare/P...S`] = { files: [{ filename: "docs/a.md" }] };
  const { api, seen } = fakeApi(routes);
  assert.equal((await decide(pushArgs(api))).heavy, false);
  assert.ok(!seen.some((p) => p.includes("/actions/")));
});

test("an API error surfaces as an exception, which the entry point turns into a full run", async () => {
  const routes = pushRoutes();
  routes[`/repos/${REPO}/commits/S/pulls`] = 500;
  const { api } = fakeApi(routes);
  await assert.rejects(decide(pushArgs(api)), /HTTP 500/);
});

test("workflow_dispatch always runs in full", async () => {
  const { api } = fakeApi({});
  assert.equal((await decide({ api, repo: REPO, eventName: "workflow_dispatch", event: {}, ignore: "" })).heavy, true);
});

test("entry point fails open: an unreachable API reports heavy=true with a warning", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
  const eventPath = join(dir, "event.json");
  const outPath = join(dir, "out");
  writeFileSync(eventPath, JSON.stringify(prEvent));
  writeFileSync(outPath, "");
  const stdout = execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "ci-gate.mjs")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: REPO,
      GITHUB_API_URL: "http://127.0.0.1:9",
      GITHUB_TOKEN: "t",
      IGNORE_PATHS: DOCS,
    },
  });
  assert.match(stdout, /::warning title=ci-gate::/);
  assert.match(readFileSync(outPath, "utf8"), /^heavy=true$/m);
});
