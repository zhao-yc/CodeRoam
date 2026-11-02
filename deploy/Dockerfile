FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY packages/protocol ./packages/protocol
COPY apps/relay ./apps/relay
USER node
EXPOSE 8787
CMD ["node", "apps/relay/cli.mjs", "--config", "/run/config/relay.json", "--host", "0.0.0.0", "--port", "8787"]
