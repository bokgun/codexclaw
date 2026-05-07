# Raspberry Pi Smoke Path

This is a smoke path for Raspberry Pi 4 / 8GB class devices running 64-bit Linux. It is not a performance guarantee.

## Assumptions

- ARM64 Linux userspace.
- Bun supports the installed OS and architecture.
- `codex` CLI is installed and authenticated for the user that runs codexclaw.
- The project workspace and state directory are on reliable storage.

## Steps

Install Bun 1.1 or newer for Linux ARM64 using the upstream Bun installation instructions, then verify it is available:

```sh
bun --version
```

Install dependencies:

```sh
bun install
```

Create local configuration:

```sh
cp .env.example .env
```

Use loopback mode and keep state outside the workspace:

```env
CODEXCLAW_DEPLOYMENT_MODE=local_loopback
CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500
CODEXCLAW_CODEX_LISTEN=ws://127.0.0.1:4500
CODEXCLAW_WORKSPACE_ROOT=/home/pi/workspace/project
CODEXCLAW_STATE_DIR=/home/pi/.codexclaw
```

Run repo checks:

```sh
bun run typecheck
bun run schema:verify
```

Start the app-server helper:

```sh
bun run start:codex
```

Check readiness from another shell:

```sh
curl -fsS http://127.0.0.1:4500/readyz
```

Run the CLI smoke and quit:

```sh
bun run cli
/quit
```

Optional channel smoke, only when credentials and allowlists are configured:

```sh
bun run telegram
```

```sh
bun run discord
```

## Expected Limits

Dependency installation, TypeScript typecheck, schema verification, and first app-server startup may be slow on Pi storage. Keep the workspace narrow, avoid broad home-directory mounts, and leave remote/public access behind WSS as described in [WSS Reverse Proxy](./wss-reverse-proxy.md).

For failures, collect the command, exit code, Bun version, Codex CLI version, CPU architecture, memory size, and the JSON-line stderr logs described in [Logging](../logging.md). Do not paste bearer tokens, raw prompts, raw diffs, raw tool output, or conversation bodies into issue reports.
