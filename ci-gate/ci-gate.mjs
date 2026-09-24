#!/usr/bin/env node
/**
 * ci-gate
 *
 * Decides whether a workflow's heavy jobs have anything to prove on this run,
 * and writes `heavy=true|false` plus a one-line `reason` to $GITHUB_OUTPUT.
 * Heavy jobs then carry `if: needs.<gate job>.outputs.heavy == 'true'`.
 *
 * Rules, in order:
 *   1. Path filter (pull_request: the pull request's files; push: the pushed
 *      range). With `only`, heavy is false when no changed file matches one of
 *      its globs. With `ignore`, heavy is false when every changed file matches
 *      one of its globs (a docs-only change). Both may be given: then a change
 *      must hit `only` and must not be all `ignore`. An empty change list is
 *      heavy.
 *   2. Verified push (push to the default branch, `skip-verified-push`): heavy
 *      is false when the pushed commit came from a merged pull request whose
 *      head has the same tree, the pre-merge main is an ancestor of that head
 *      (so main did not move underneath the pull request run), and a run of
 *      this same workflow for that head on the pull_request event succeeded.
 *      That run already tested exactly this code against exactly this main.
 *   3. Anything else is heavy (workflow_dispatch, schedule, other branches).
 *
 * Fails open: an API error never skips work. It prints a warning and reports
 * heavy=true, because a skipped test that should have run is the one outcome
 * that looks like success.
 *
 * Globs match the whole path from the repo root: `*` stays inside one path
 * segment, `**` crosses segments, `**` followed by a slash also matches zero
 * segments, and `?` is one character. `docs/**` is everything under docs, and
 * `**` then a slash then `*.md` is markdown at any depth.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- globs
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function parseGlobs(text) {
  return (text ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

export const matchesAny = (file, regexps) => regexps.some((r) => r.test(file));

// ---------------------------------------------------------------- GitHub API
// Every request gets its own timeout, and the whole decision a total budget:
// Node's fetch otherwise waits up to 300 s for headers and again between body
// chunks, and a gate that hangs holds up every job behind it. Past either
// limit the call throws, which the entry point turns into a full run.
export const REQUEST_TIMEOUT_MS = 15_000;
export const TOTAL_BUDGET_MS = 60_000;

export function makeApi({
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  totalBudgetMs = TOTAL_BUDGET_MS,
}) {
  const deadline = Date.now() + totalBudgetMs;
  const call = async (path) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`the ${totalBudgetMs} ms budget for API calls ran out before GET ${path}`);
    const signal = AbortSignal.timeout(Math.min(requestTimeoutMs, left));
    try {
      const res = await fetchImpl(`${apiUrl}${path}`, {
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!res.ok) throw new Error(`GET ${path} answered HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (signal.aborted) throw new Error(`GET ${path} timed out`);
      throw e;
    }
  };
  return {
    call,
    // The pull request files endpoint stops at 3000 files; past that the list
    // is incomplete, so the caller treats it as "cannot tell" (heavy).
    async pullFiles(repo, number) {
      const files = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await call(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
        files.push(...batch.flatMap(paths));
        if (batch.length < 100) return { files, complete: true };
      }
      return { files, complete: false };
    },
  };
}

// A renamed file counts under both names: moving src/a.ts to docs/a.md removes
// code from the build, so it must not read as a docs-only change, and moving a
// file out of an only-paths folder must still count as touching it.
const paths = (f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]);

// ---------------------------------------------------------------- decision
const NO_COMMIT = /^0+$/;

async function changedFiles({ api, repo, event, eventName }) {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const { files, complete } = await api.pullFiles(repo, event.pull_request.number);
    return complete ? files : null;
  }
  if (eventName === "push") {
    if (!event.before || NO_COMMIT.test(event.before)) return null;
    const cmp = await api.call(`/repos/${repo}/compare/${event.before}...${event.after}`);
    // compare lists at most 300 files; a longer list is incomplete.
    if (!Array.isArray(cmp.files) || cmp.files.length >= 300) return null;
    return cmp.files.flatMap(paths);
  }
  return null;
}

async function verifiedPush({ api, repo, sha, runId }) {
  const pulls = await api.call(`/repos/${repo}/commits/${sha}/pulls`);
  const pr = pulls.find((p) => p.merged_at);
  if (!pr) return { ok: false, why: "no merged pull request for this commit" };
  const head = pr.head.sha;

  const pushed = await api.call(`/repos/${repo}/commits/${sha}`);
  const parent = pushed.parents?.[0]?.sha;
  if (!parent) return { ok: false, why: "the pushed commit has no parent" };
  const headCommit = await api.call(`/repos/${repo}/git/commits/${head}`);
  if (headCommit.tree.sha !== pushed.commit.tree.sha) {
    return { ok: false, why: `pull request #${pr.number} was not up to date with main when it merged` };
  }
  const cmp = await api.call(`/repos/${repo}/compare/${parent}...${head}`);
  if (cmp.status !== "ahead" && cmp.status !== "identical") {
    return { ok: false, why: `main moved underneath pull request #${pr.number}` };
  }

  const thisRun = await api.call(`/repos/${repo}/actions/runs/${runId}`);
  const runs = await api.call(
    `/repos/${repo}/actions/workflows/${thisRun.workflow_id}/runs?event=pull_request&head_sha=${head}&status=success&per_page=1`,
  );
  const passed = runs.workflow_runs?.[0];
  if (!passed) return { ok: false, why: `no successful pull request run of this workflow for #${pr.number}` };
  return { ok: true, why: `pull request #${pr.number} already passed on the same tree (run ${passed.id})` };
}

export async function decide({ api, repo, eventName, event, runId, defaultBranch, ignore, only, skipVerifiedPush }) {
  const onlyRe = parseGlobs(only).map(globToRegExp);
  const ignoreRe = parseGlobs(ignore).map(globToRegExp);

  if (onlyRe.length || ignoreRe.length) {
    const files = await changedFiles({ api, repo, event, eventName });
    if (files && files.length) {
      if (onlyRe.length && !files.some((f) => matchesAny(f, onlyRe))) {
        return { heavy: false, reason: `none of ${files.length} changed files match the only-paths filter` };
      }
      if (ignoreRe.length && files.every((f) => matchesAny(f, ignoreRe))) {
        return { heavy: false, reason: `all ${files.length} changed files match the ignore-paths filter` };
      }
    }
  }

  const ref = event.ref ?? "";
  if (skipVerifiedPush && eventName === "push" && ref === `refs/heads/${defaultBranch}`) {
    const v = await verifiedPush({ api, repo, sha: event.after, runId });
    if (v.ok) return { heavy: false, reason: v.why };
    return { heavy: true, reason: `full run: ${v.why}` };
  }
  return { heavy: true, reason: `full run (${eventName})` };
}

// ---------------------------------------------------------------- entry
async function main() {
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const api = makeApi({ token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL });
  let result;
  try {
    result = await decide({
      api,
      repo: env.GITHUB_REPOSITORY,
      eventName: env.GITHUB_EVENT_NAME,
      event,
      runId: env.GITHUB_RUN_ID,
      defaultBranch: env.DEFAULT_BRANCH || event.repository?.default_branch || "main",
      ignore: env.IGNORE_PATHS,
      only: env.ONLY_PATHS,
      skipVerifiedPush: env.SKIP_VERIFIED_PUSH === "true",
    });
  } catch (e) {
    console.log(`::warning title=ci-gate::${e.message}; running everything`);
    result = { heavy: true, reason: `full run: the gate could not decide (${e.message})` };
  }
  console.log(`${result.heavy ? "heavy" : "skip"}: ${result.reason}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `heavy=${result.heavy}\nreason=${result.reason}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `**ci-gate${env.GATE_NAME ? ` (${env.GATE_NAME})` : ""}:** ${result.heavy ? "run" : "skip"}, ${result.reason}\n\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
