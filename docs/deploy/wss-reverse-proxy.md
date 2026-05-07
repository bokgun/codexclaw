# WSS Reverse Proxy

Use `reverse_proxy_wss` when codexclaw reaches `codex app-server` through a remote or public endpoint. codexclaw requires `wss://` in this mode and rejects plaintext non-loopback `ws://`.

## Flow

```text
codexclaw runtime
  -> wss://codex.example.com
  -> reverse proxy with TLS termination
  -> loopback or internal ws:// codex app-server
  -> bearer token checked by codex app-server
```

The reverse proxy terminates TLS. `codex app-server` should still bind only to loopback on a single host, or to an internal container/network address that is not exposed directly to the internet.

## Environment

```env
CODEXCLAW_DEPLOYMENT_MODE=reverse_proxy_wss
CODEXCLAW_CODEX_WS=wss://codex.example.com
CODEXCLAW_CODEX_LISTEN=ws://127.0.0.1:4500
CODEXCLAW_WORKSPACE_ROOT=/srv/codexclaw/workspace
CODEXCLAW_STATE_DIR=/srv/codexclaw/state
CODEXCLAW_CODEX_TOKEN_FILE=/srv/codexclaw/state/codex.token
CODEXCLAW_DB=/srv/codexclaw/state/codexclaw.sqlite
```

In `reverse_proxy_wss` mode the token file must already exist. Create it with private permissions before starting the helper:

```sh
install -d -m 700 /srv/codexclaw/state
umask 077
openssl rand -hex 32 > /srv/codexclaw/state/codex.token
chmod 600 /srv/codexclaw/state/codex.token
```

Do not put credentials in the WebSocket URL. `CODEXCLAW_CODEX_WS` rejects usernames, passwords, query parameters, and fragments.

## Caddy Example

```caddy
codex.example.com {
  reverse_proxy 127.0.0.1:4500
}
```

The app-server handles the bearer-token WebSocket authentication. Configure clients with the same token file that was passed to `codex app-server`; do not copy the token into URLs or logs.

## Readiness

The app-server exposes `GET /readyz` on the same listener. Check it through the proxy:

```sh
curl -fsS https://codex.example.com/readyz
```

Or check the internal listener locally:

```sh
curl -fsS http://127.0.0.1:4500/readyz
```

## Security Notes

WSS protects the transport and the bearer token gates app-server access. codexclaw still delegates sandboxing, approval enforcement, edits, patches, model routing, and rollout storage to Codex. Do not weaken Codex sandbox or approval settings to make remote access easier.
