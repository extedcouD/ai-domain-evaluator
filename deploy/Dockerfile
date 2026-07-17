# KB Studio — multi-user server image.
#
# The image is STATELESS: it holds the app + the built UI. The KB git repo and the per-user worktrees
# live on a mounted volume (/data), so the container can be rebuilt/replaced without touching data.
# @evaluator/core is resolved from TypeScript source by tsx at runtime, so only the UI needs a build.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @evaluator/studio build   # vite build -> packages/studio/dist (served by the API)

ENV KB_MULTI_USER=1 \
    KB_STUDIO_PORT=4319
EXPOSE 4319
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
