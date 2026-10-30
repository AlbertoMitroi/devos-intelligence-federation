# intelligence-federation image: deps, test, runtime and action stages. Node.js 24 LTS runs the TypeScript sources
# directly (type stripping); node:sqlite (with FTS5) writes index.sqlite. Same base image digest as angular-intelligence.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS deps
WORKDIR /opt/intelligence-federation
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Type check, unit tests and the vendored contract check. A failing test fails the build.
FROM deps AS test
COPY . .
RUN npx tsc -p tsconfig.json \
 && node --disable-warning=ExperimentalWarning --test --test-reporter=spec "tests/unit/*.test.ts"

FROM ${NODE_IMAGE} AS runtime
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    npm_config_update_notifier=false
WORKDIR /opt/intelligence-federation
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY schema ./schema
RUN mkdir -p /generations /out /config && chmod 1777 /out
USER node
WORKDIR /out
ENTRYPOINT ["node", "/opt/intelligence-federation/src/cli.ts"]
CMD ["--help"]

# GitHub Docker container actions run as root to write GITHUB_WORKSPACE; the output is handed back to its owner.
FROM runtime AS action
USER root
