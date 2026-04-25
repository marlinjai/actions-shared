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

## Versioning

Callers always pin to a version tag (`@v1`, `@v2`). Never `@main`. Breaking changes ship as new tags; current callers stay on the old tag until they migrate.

- `v1` is additive-only.
- A breaking change (renaming inputs, removing inputs, restructuring the lifecycle) gets `v2` and a per-caller migration.

## Related

- Plan: [`marlinjai/infra/plans/2026-04-20-canonical-cicd-pattern.md`](https://github.com/marlinjai/infra)
- Pattern doc: [`marlinjai/infra/docs/public/ci-cd-pattern.md`](https://github.com/marlinjai/infra)
