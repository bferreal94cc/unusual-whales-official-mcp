# Secrets and configuration

This server needs exactly one secret: `UW_API_KEY`, your Unusual Whales API key.
Everything else in [`.env.example`](../.env.example) is non-sensitive tuning.

**No secret value belongs in this repository.** Git history is permanent — a key
committed and later deleted is still recoverable from the object store, and from
every fork and clone made in between. Use one of the three places below instead.

## 1. Local development

```bash
cp .env.example .env
# edit .env, set UW_API_KEY=...
```

`.env` and `.env.local` are already in [`.gitignore`](../.gitignore). Verify
before committing:

```bash
git check-ignore -v .env      # should print the .gitignore rule
git status --short            # .env must not appear
```

Nothing in the source loads `.env` automatically — it reads `process.env`
directly ([`src/gateway.ts`](../src/gateway.ts)). Export it in your shell, use
`node --env-file=.env`, or let your MCP client pass the variable in.

## 2. MCP client configuration

The key is supplied by whichever client launches the server, not by a file in
this repo.

Claude Code:

```bash
claude mcp add unusualwhales -e UW_API_KEY=YOUR_KEY -- npx -y @unusualwhales/mcp
```

Claude Desktop (`claude_desktop_config.json`) — see the README for the full
block. That config file lives outside the repo and holds the real key.

If you use the remote transport instead, the key travels as
`Authorization: Bearer YOUR_KEY` in a `--header` arg rather than as an env var.

## 3. GitHub Actions

Neither workflow currently needs a secret:

- [`test.yml`](../.github/workflows/test.yml) runs lint, build, and tests. The
  test suite does not call the live API, so no key is required.
- [`publish.yml`](../.github/workflows/publish.yml) publishes to npm using OIDC
  trusted publishing (`permissions: id-token: write`). **Do not add an
  `NPM_TOKEN` secret** — OIDC exists to avoid that long-lived credential.

If a future workflow does need the API key, add it as an encrypted repository
secret and reference it as an env var — never inline:

```bash
gh secret set UW_API_KEY --repo bferreal94cc/unusual-whales-official-mcp
```

Or via the web UI: **Settings → Secrets and variables → Actions → New
repository secret**.

```yaml
- run: npm run test:integration
  env:
    UW_API_KEY: ${{ secrets.UW_API_KEY }}
```

Notes on Actions secrets:

- Secrets are **not** passed to workflows triggered by `pull_request` from a
  fork. Use `pull_request_target` deliberately, or skip key-dependent jobs on
  fork PRs.
- Actions masks a secret's exact value in logs, but not values derived from it.
  Do not echo, base64, or interpolate a secret into a shell string.
- Prefer an [environment](https://docs.github.com/actions/deployment/targeting-different-environments)
  secret with required reviewers for anything that spends against a paid plan.

## If a key is exposed

1. Rotate it first — revoke and reissue in your Unusual Whales account.
   Rotation is what actually fixes the exposure.
2. Then clean up: remove the value from the working tree and commit.

Rewriting history (`git filter-repo`, force-push) does not undo the leak — the
key was public the moment it was pushed, and forks keep their copies. Rotate
regardless.
