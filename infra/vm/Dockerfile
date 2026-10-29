# AniScroll sur la VM Oracle (arm64). Construit SUR la VM : `docker compose build`.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Optionnelles comprises : @next/swc-linux-arm64 en est une.
RUN npm ci --no-audit --no-fund
COPY . .
# Les NEXT_PUBLIC_* sont figees dans le bundle au build.
ARG NEXT_PUBLIC_PROXY_BASE
ARG NEXT_PUBLIC_IMG_PROXY
ARG NEXT_PUBLIC_ADMIN_USERNAMES
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
