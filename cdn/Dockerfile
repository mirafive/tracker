# syntax=docker/dockerfile:1
# The image behind cdn.mirafive.io. Build context is the repository root:
#   docker build -f cdn/Dockerfile -t mirafive-cdn .
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --frozen-lockfile
COPY . .
RUN bun run build \
 && mkdir -p /site \
 && bun cdn/history.ts /site \
 && cp -R dist/. /site/ \
 && cp cdn/legacy/*.js /site/ \
 && find /site \( -name '*.js' -o -name '*.json' \) -exec gzip -9 -k {} +

FROM nginxinc/nginx-unprivileged:1.29-alpine-slim
COPY --link cdn/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --link /site /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
