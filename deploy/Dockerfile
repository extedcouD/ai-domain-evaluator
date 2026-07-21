# KB Studio — multi-user server image.
#
# The image is STATELESS: it holds the app + the built UI. All state lives in MongoDB (a compose service
# or the EC2 host's mongod), so the container can be rebuilt/replaced without touching data.
# @evaluator/core is resolved from TypeScript source by tsx at runtime, so only the UI needs a build.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app
COPY . .
# The server never uses mongodb-memory-server (dev-only), so skip its ~66MB binary download at build.
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @evaluator/studio build   # vite build -> packages/studio/dist (served by the API)

ENV KB_MULTI_USER=1 \
    KB_STUDIO_PORT=4319
EXPOSE 4319
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
