# Node API. Build from the repository root:
#   docker build -t shop-api-node .
# The server needs the same PostgreSQL schema the Nest API (eCommerce-api) migrates; see README.md.
# The build downloads @ecom/contracts from its tagged GitHub release (see package.json), so it needs network access.

# ---- build stage: locked install, Prisma client generation, TypeScript build ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm build

# ---- runtime stage: compiled output, the generated client and production dependencies only ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3333
WORKDIR /app
RUN corepack enable
COPY --chown=node:node package.json pnpm-lock.yaml ./
# pnpm builds the git-hosted @ecom/contracts package during install, and that build needs dev tools, which pnpm skips under
# `--prod` or NODE_ENV=production. So install everything for this one step, then prune back to production dependencies.
RUN NODE_ENV=development pnpm install --frozen-lockfile && pnpm prune --prod && rm -rf /root/.cache /root/.local/share/pnpm
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/generated ./generated
USER node
EXPOSE 3333
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node", "dist/main.js", "-healthcheck"]
CMD ["node", "dist/main.js"]
