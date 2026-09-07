# actions-shared

Public reusable GitHub Actions workflows shared across `marlinjai/*` and `Lola-Stories/*` repos.

This repository exists because GitHub does not allow cross-repo reusable workflows between private repos owned by a personal account, even with `access_level: user` on the source repo. Hosting the workflow here (public) sidesteps that restriction without exposing operational configuration.

## Workflows

### `coolify-deploy-verify.yml`

Brackets a Coolify deploy webhook with GitHub Deployments API status transitions and a retry-curl smoke test against the public health URL. Closes silent-failure deploys (green CI, green Coolify, stale site) within ~80s.

**Caller pattern:**

```yaml
deploy-verify:
  needs: build-and-push
  uses: marlinjai/actions-shared/.github/workflows/coolify-deploy-verify.yml@v1
  with:
    health_url: https://example.com/api/health
    environment: production           # or production-<service> for multi-service repos
    # max_wait_seconds: 80            # optional, default 80
  secrets:
    coolify_webhook: ${{ secrets.COOLIFY_WEBHOOK }}
    coolify_token:   ${{ secrets.COOLIFY_TOKEN }}
```

**Inputs:**

| Input | Required | Default | Notes |
|-------|----------|---------|-------|
| `health_url` | yes | none | No fallback to `/`. Forces the caller to specify a real health endpoint. |
| `environment` | yes | none | GitHub Deployments environment. Use `production-<service>` in multi-service repos so Vercel and Coolify histories don't mix. |
| `max_wait_seconds` | no | 80 | Bump per-app if cold starts exceed budget. |

**Secrets:**

| Secret | Notes |
|--------|-------|
| `coolify_webhook` | Coolify deploy webhook URL. |
| `coolify_token` | Coolify API bearer token. |

## Actions

### `roadmap-check`

The root `ROADMAP.md` is the only index of open work in a repo; plan files are the only place content lives. This composite action fails the build when the two disagree, so an open item can never quietly live nowhere or in two places. The rule it enforces is written up in the knowledge-base document-lifecycle standard ("Open work has one home").

**Rules** (every violation is printed in one run, so one edit clears them):

1. Every plan link on the roadmap points at a file that exists.
2. An open line (`- [ ]`) never links a plan whose status is completed, archived or rejected.
3. A plan with status decided or in-progress is linked from at least one open line, or from a plan that is. A repo with live plans and no `ROADMAP.md` fails here; a repo with neither is skipped with a notice.
4. Every open line carries a last-confirmed date `(YYYY-MM-DD)` (the last such token in the item wins, so wrapped bullets are fine).
5. An open line older than `max-age` days fails; an unlinked draft plan whose frontmatter `date` is older than `max-age` days fails.
6. A plan's `status`, when present, is one of draft, decided, in-progress, completed, archived, rejected. A missing status reads as draft; a plan with neither status nor date fails.

Only checkbox lines are items; prose, headings and tables are ignored, so a roadmap in another style needs no rewrite. Plans are discovered in `docs/plans`, `plans`, `docs/superpowers`, `docs/specs`, `docs/research` and `docs/decisions`. Files whose frontmatter `type` is handover, documentation, readme, roadmap or changelog are never checked.

**Caller pattern** (run on pull requests and on pushes to the default branch):

```yaml
roadmap-check:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: marlinjai/actions-shared/roadmap-check@roadmap-check-v1
      with:
        max-age: 30              # optional, default 30; lumitra-studio uses 14
        # plans-dir: "plans"     # optional, space/comma separated; default is the six folders above
        # roadmap: ROADMAP.md    # optional
```

**Inputs:**

| Input | Required | Default | Notes |
|-------|----------|---------|-------|
| `max-age` | no | 30 | Days an open line or an unlinked draft may go without being re-confirmed. |
| `plans-dir` | no | the six default folders | Override when a repo keeps plans elsewhere (knowledge-base passes `plans`). |
| `roadmap` | no | `ROADMAP.md` | Path relative to the repo root. |
| `working-directory` | no | `.` | Repo root to check. |

**Local run** (same script, no npm publish involved):

```sh
npx --yes github:marlinjai/actions-shared#roadmap-check-v1 roadmap-check --max-age 30
# or, with a checkout of this repo:
node ~/software-dev/actions-shared/roadmap-check/check-roadmap.mjs --root . --max-age 30
```

Tests: `npm test` (node:test, fixtures built in temp dirs, one case per rule).

## Versioning

Callers always pin to a version tag (`@v1`, `@v2`). Never `@main`. Breaking changes ship as new tags; current callers stay on the old tag until they migrate.

- `v1` (the deploy-verify workflow) is additive-only.
- `roadmap-check-v1` is the tag for the roadmap-check action. It moves forward with additive fixes; a breaking change to its rules or inputs gets `roadmap-check-v2`. The two tag families move independently, so a check fix never touches deploy-verify consumers.
- A breaking change (renaming inputs, removing inputs, restructuring the lifecycle) gets a new major tag and a per-caller migration.

## Related

- Plan: [`marlinjai/infra/plans/2026-04-20-canonical-cicd-pattern.md`](https://github.com/marlinjai/infra)
- Pattern doc: [`marlinjai/infra/docs/public/ci-cd-pattern.md`](https://github.com/marlinjai/infra)
