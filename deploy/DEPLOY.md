# Deploying KB Studio (multi-user) on EC2

This runs KB Studio as a hosted, multi-author tool: everyone signs in with SSO, each person edits in
their own isolated **workspace** (a personal copy of the KB), and changes reach the shared KB only
through a reviewed merge. Nothing is silently lost — every change is an attributed revision in Mongo,
with a History/Trash panel for recovery.

```
Internet ──443──▶ Caddy (TLS) ──▶ oauth2-proxy (SSO) ──▶ studio (node) ──▶ MongoDB
                                     injects                per-author           (workspaces / topics /
                                 X-Forwarded-Email          workspaces            config / revisions)
```

Only Caddy is exposed to the internet. `studio` and `oauth2-proxy` sit on the internal Docker network,
so the trusted identity header cannot be spoofed from outside.

---

## 1. Prerequisites (before touching EC2)

1. **A GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: `https://kb.yourcompany.com`
   - Authorization callback URL: `https://kb.yourcompany.com/oauth2/callback`
   - Note the **Client ID** and **Client Secret**.
2. **Your admin emails** (seeded on first boot; they then govern access from the Admin page) — e.g.
   `alice@yourcompany.com`.
3. **Durable Docker storage**. MongoDB runs in the Compose stack by default; ensure Docker's data
   directory is backed by the EC2's durable EBS volume. A standalone mongod is sufficient — no replica
   set is required.

GitHub is only the SSO identity provider now — there is no KB git repo, no server token, and no PRs.

## 2. Provision the EC2 instance

1. Launch an instance (Ubuntu 22.04+, `t3.small` is plenty) with an **Elastic IP**.
2. Attach (or use the root) **EBS volume** — this holds the Mongo data directory. 20 GB is ample.
3. **Security group**: inbound `443` (HTTPS) and `80` (only for the TLS challenge) from the internet,
   and `22` (SSH) from your IP. **Do not** open 4180/7674/27017 — those stay internal.
4. **DNS**: point `kb.yourcompany.com` (an A record) at the Elastic IP.
5. Install Docker + the compose plugin:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER && newgrp docker
   ```
6. (If using the host's mongod) install MongoDB and ensure it listens on `127.0.0.1:27017`.

## 3. Configure and launch

```bash
git clone https://github.com/extedcouD/ai-domain-evaluator.git
cd ai-domain-evaluator/deploy
cp .env.example .env
nano .env          # fill in KB_HOST, MONGODB_URI, KB_DB_NAME, KB_ADMINS,
                   # OAUTH_CLIENT_ID/SECRET, OAUTH_COOKIE_SECRET (openssl rand -base64 32)

docker compose --env-file .env up -d --build

docker compose logs -f            # watch it import the seed KB on first boot; Caddy fetches a cert
```

On first boot the server imports the YAML seed KB baked into the image (`/app/kb`) into Mongo, then
Mongo is the source of truth. To (re)run the import by hand against your database:
`pnpm studio:migrate` (add `--force` to overwrite a populated store).

Visit `https://kb.yourcompany.com` → GitHub login → you're in.

## 4. A day in the life

- **First visit** by anyone → a read-only **viewer** on the shared KB (`main`). An admin grants them
  write scopes from the **Admin** page; they become an **author**.
- **Author edits** → on their first save the server clones `main` into a personal workspace
  (`workspaces.<slug>`); every save is an attributed, hash-guarded write to *their* copy, scoped to what
  the policy allows. Other authors and viewers never see it.
- **Author clicks "⇧ Review" → Submit for review** → their workspace is flagged; the diff is computed
  live against `main`.
- **An admin merges** from the Proposals panel. The merge is all-or-nothing and hash-guarded; a
  conflicting proposal is refused until the author **Syncs with main** and resolves each conflict
  (Keep mine / Take theirs).
- **Recover anything** from the **⟲ History** panel (revision log + one-click restore of deletions).

## 5. Topic scoping

Manage access entirely from the **Admin** page (it writes the `config.access` document in Mongo):

- **Admins** — full access: write any path, edit the manifest identity, merge proposals.
- **Users & scopes** — each user may write only within their assigned path prefixes.
- **Default scopes** — applied to anyone else who signs in; empty (the default) means **read-only
  viewer**.

The policy is a single canonical document, never anything a user can write, so nobody can grant
themselves scope — a change requires an admin.

## 6. Backups & durability

- **All state is in MongoDB.** Ensure Docker's `mongo-data` volume is on the **EBS volume** and enable
  scheduled EBS snapshots, or use `mongodump` on a cron. The revision log has a TTL (`KB_HISTORY_TTL_DAYS`,
  default 365) so it self-prunes.
- The studio container is **stateless** — rebuild/replace it freely without touching data.

## 7. Operations

- **Update the app**: `git pull && docker compose --env-file .env up -d --build` (Mongo is untouched).
- **Logs**: `docker compose logs -f studio`.
- **Env vars the server reads** (all wired by compose): `KB_MULTI_USER`, `MONGODB_URI`, `KB_DB_NAME`,
  `KB_DIR` (first-boot seed), `KB_ADMINS`, `KB_HISTORY_TTL_DAYS` (default 365),
  `KB_IDENTITY_HEADER` (default `x-forwarded-email`).

## 8. Security notes

- The studio trusts `X-Forwarded-Email` **only** because it is unreachable except through oauth2-proxy.
  Never publish port 7674/4180 (or Mongo's 27017) to the host or the internet.
- Anyone who can sign in becomes a read-only viewer. To restrict *who can sign in* at all, add
  `--github-org=<org>` back to the oauth2-proxy command in `docker-compose.yml`.

## 9. Single-user / local mode (for reference)

Without `KB_MULTI_USER`, the server binds `127.0.0.1` and everyone is one dev admin on `main` — no auth,
no per-author workspaces. Still gets the revision safety net (History/Trash + restore) and
optimistic-concurrency conflict detection. Run it with `pnpm studio` from the repo root (add
`KB_MONGO_MEMORY=1` to use a throwaway in-memory Mongo, so you need no local database).
