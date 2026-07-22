# GitHub Actions deployment configuration

`deployment.yml` deploys `main` and `release-staging` using the same GitHub
environment names. It follows the `automation-db` SSH-key convention while using
separate EC2 base directories:

| Environment | EC2 checkout directory | Compose project |
| --- | --- | --- |
| `main` | `~/ONDC-automation-kb-studio/automation-kb-studio` | `automation-kb-studio` |
| `release-staging` | `~/ONDC-automation-kb-studio-staging/automation-kb-studio` | `automation-kb-studio-staging` |

Create/update an environment after authenticating the GitHub CLI. Values are
provided as shell environment variables so they are never committed:

```bash
export KB_HOST=kb.example.com
export KB_ADMINS=extedcoud@gmail.com
export MONGODB_URI=mongodb://mongo:27017
export OAUTH_CLIENT_ID=Iv1_example
export SSH_PRIVATE_KEY="$(<~/.ssh/kb-studio.pem)"
export HOST=203.0.113.10
export USER=ubuntu
export OAUTH_CLIENT_SECRET=...
export OAUTH_COOKIE_SECRET="$(openssl rand -base64 32)"

ENVIRONMENT=main bash scripts/github-actions/worker.sh
```

Repeat with the staging host, domain, OAuth callback credentials, and
`ENVIRONMENT=release-staging` as applicable. The workflow stores `KB_HOST`,
`KB_DB_NAME`, `KB_ADMINS`, `MONGODB_URI`, and `OAUTH_CLIENT_ID` as GitHub Actions variables;
the remaining inputs are stored as environment secrets.
