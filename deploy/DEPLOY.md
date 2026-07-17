# Deploying KB Studio (multi-user) on EC2

This runs KB Studio as a hosted, multi-author tool: everyone signs in with SSO, each person edits in
their own isolated git branch, and changes reach the shared KB only through reviewed pull requests.
Nothing is ever lost — every change is an attributed git commit, backed off-site on GitHub.

```
Internet ──443──▶ Caddy (TLS) ──▶ oauth2-proxy (SSO) ──▶ studio (node) ──▶ KB git repo on EBS
                                     injects                per-user            │
                                 X-Forwarded-Email        git worktrees         └─▶ push / PR / merge ──▶ GitHub
```

Only Caddy is exposed to the internet. `studio` and `oauth2-proxy` sit on the internal Docker network,
so the trusted identity header cannot be spoofed from outside.

---

## 1. Prerequisites (before touching EC2)

1. **A KB git repo on GitHub** whose **root is the KB** — i.e. it contains `manifest.meta.yaml`,
   `topics/…`, and (optionally) `access.yaml`. If your KB currently lives in a subfolder, split it into
   its own repo. This is the repo the server clones, branches per user, and merges into.
2. **A GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: `https://kb.yourcompany.com`
   - Authorization callback URL: `https://kb.yourcompany.com/oauth2/callback`
   - Note the **Client ID** and **Client Secret**.
3. **A GitHub token** with `repo` scope (a bot account or fine-grained token is best). The *server* uses
   it to fetch/push user branches and to open + merge PRs.
4. **Your admin emails** (who may merge proposals) — e.g. `alice@yourcompany.com`.

## 2. Provision the EC2 instance

1. Launch an instance (Ubuntu 22.04+, `t3.small` is plenty) with an **Elastic IP**.
2. Attach (or use the root) **EBS volume** — this holds the live KB repo + worktrees. 20 GB is ample.
3. **Security group**: inbound `443` (HTTPS) and `80` (only for the TLS challenge) from the internet,
   and `22` (SSH) from your IP. **Do not** open 4180/4319 — those stay internal.
4. **DNS**: point `kb.yourcompany.com` (an A record) at the Elastic IP.
5. Install Docker + the compose plugin:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER && newgrp docker
   ```

## 3. Configure and launch

```bash
git clone https://github.com/extedcouD/ai-domain-evaluator.git
cd ai-domain-evaluator/deploy
cp .env.example .env
nano .env          # fill in KB_HOST, KB_GITHUB_REPO, KB_GITHUB_TOKEN, KB_ADMINS,
                   # OAUTH_CLIENT_ID/SECRET, OAUTH_COOKIE_SECRET (openssl rand -base64 32), GITHUB_ORG

docker compose --env-file .env up -d --build
docker compose logs -f            # watch it clone the KB repo + start; Caddy will fetch a cert
```

Visit `https://kb.yourcompany.com` → GitHub login → you're in.

## 4. A day in the life

- **First visit** by `bob@corp.com` → the server creates a worktree on branch `user/bob-corp-com` from
  the current `main`. Bob sees the live KB.
- **Bob edits topics** → each save is an auto-commit to *his* branch, authored as Bob, scoped to what
  `access.yaml` allows.
- **Bob clicks "⇧ Review" → Submit for review** → his branch is pushed and a PR opens.
- **An admin merges** (in GitHub or the Proposals panel). The server then fast-forwards the deployment's
  local `main`, so everyone's next "Sync with main" and every new worktree sees the merged KB.
- **Recover anything** from the **⟲ History** panel (per-commit log + one-click restore of deletions).

## 5. Topic scoping (optional but recommended)

Commit an `access.yaml` to the **root of the KB repo** to restrict who edits what:

```yaml
admins:
  - alice@corp.com                       # full access + can merge + cascade-delete
users:
  bob@corp.com:   { scopes: [[ondc, protocol, foundation]] }
  carol@corp.com: { scopes: [[ondc, protocol, domains, retail]] }
defaults:
  scopes: []                             # everyone else: read-only
```

The server reads this from the **canonical `main`**, never a user's branch, so nobody can grant
themselves scope by editing their own copy — a real change must be merged by an admin. With no
`access.yaml`, everyone can edit everything (open mode).

## 6. Backups & durability

- **Off-site backup is automatic**: `main` and every user branch live on GitHub. If the EC2 dies,
  `docker compose up` on a fresh box re-clones and you're back — no data lost.
- The **EBS volume** only holds the live working copies + worktrees (disposable). Optionally enable
  scheduled EBS snapshots as belt-and-suspenders.

## 7. Operations

- **Update the app**: `git pull && docker compose --env-file .env up -d --build` (the KB volume is untouched).
- **Logs**: `docker compose logs -f studio` (also prints any git push / backup warnings).
- **Env vars the server reads** (all wired by compose): `KB_MULTI_USER`, `KB_REPO_DIR`, `KB_DIR`,
  `KB_WORKTREES_DIR`, `KB_GITHUB_TOKEN`, `KB_GITHUB_REPO`, `KB_ADMINS`, `KB_REVIEW_REMOTE` (default
  `origin`), `KB_REVIEW_BASE` (default `main`), `KB_IDENTITY_HEADER` (default `x-forwarded-email`).

## 8. Security notes

- The studio trusts `X-Forwarded-Email` **only** because it is unreachable except through oauth2-proxy.
  Never publish port 4319/4180 to the host or the internet.
- The GitHub token grants push/merge on the KB repo — scope it to that one repo (fine-grained token) and
  rotate it periodically.

## 9. Single-user / local mode (for reference)

Without `KB_MULTI_USER`, the server is the original single-user tool bound to `127.0.0.1` — everyone
shares one workspace, no auth, no branches. Still gets the git safety net (History/Trash + restore) and
optimistic-concurrency conflict detection. Run it with `pnpm studio` from the repo root.
