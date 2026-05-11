# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

ARG CODEX_CLI_VERSION=0.128.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git gosu openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
  && codex --version

RUN groupadd --system --gid 10001 codex \
  && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/codex codex \
  && mkdir -p /workspace /home/codex/.codex \
  && chown -R codex:codex /workspace /home/codex

COPY docker/codex-app-server-entrypoint.sh /usr/local/bin/codex-app-server-entrypoint
RUN chmod 0755 /usr/local/bin/codex-app-server-entrypoint

ENV CODEX_HOME=/home/codex/.codex
WORKDIR /workspace
EXPOSE 4500

ENTRYPOINT ["codex-app-server-entrypoint"]
CMD ["codex", "app-server", "--listen", "ws://0.0.0.0:4500", "--ws-auth", "capability-token", "--ws-token-file", "/tmp/codexclaw/codex.token"]
