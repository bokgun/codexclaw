# Container Docker Artifacts Plan

## Goal

Add bounded Docker and container-runtime artifacts that unblock
`docs/M4-manual-checklist.md` section 3 while preserving the PRD isolation
model: `codex app-server` runs inside an isolated runtime, codexclaw remains a
thin host/client outside that runtime by default, codexclaw state and SQLite stay
outside the Codex-editable workspace, and plaintext app-server access remains
loopback-only or internal.

## PRD References

- PRD section 5.3: recommended deployment runs `codex app-server` in Docker and
  keeps codexclaw on the host, connected by loopback or forwarded WebSocket.
- PRD sections 6.1-6.4: WebSocket/WSS transport, `/readyz`, bearer token file,
  and WSS requirement for public exposure.
- PRD section 9: token permissions, WSS, and no weakening of Codex sandbox or
  approval behavior.
- `docs/ROADMAP.md` M4: container deployment guidance and fresh-clone usability.
- `docs/deploy/container.md`: current container boundary reference.
- `docs/M4-manual-checklist.md`: section 3 is currently blocked without
  executable container artifacts.

## Scope

- Add a reference Docker image artifact for running `codex app-server`.
- Add build/run or compose-level artifacts that demonstrate safe loopback-only
  app-server exposure.
- Add `.dockerignore` so local state, tokens, databases, env files, dependency
  caches, and rollout-like data do not enter the image build context.
- Document Apple Container support level and commands only after a smoke run; if
  unverified, mark it as documented-only and point to the same mount and network
  boundaries.
- Update deployment docs, README, and M4 checklist with concrete artifact
  commands.
- Keep host codexclaw state, database, scheduler data, approvals, and prefs out
  of the app-server container.

## Non-goals

- No production image publishing pipeline.
- No Kubernetes chart.
- No general host-to-container path mapping layer.
- No reimplementation of Codex sandboxing, approval enforcement, rollout
  storage, or model routing.
- No requirement that Telegram or Discord run inside the app-server container.
- No broad host-home or credential-directory mounts.
- No broad Codex config or credential sharing with the app-server container.
  Any Codex CLI authentication needed inside the container must use a narrow,
  documented secret/config boundary or an isolated container-owned login volume.

## Ordered Tasks

1. Confirm artifact shape and runtime boundaries.
   - Dependencies: PRD section 5.3, current installer/env behavior, and
     `docs/deploy/container.md`.
   - Expected decision: Docker reference is the first executable artifact;
     Apple Container support is either smoke-verified with exact commands or
     explicitly documented as unverified but boundary-equivalent.
   - Validation: plan and docs state that codexclaw runs on the host by default,
     `codex app-server` runs in the container, and the same absolute
     `CODEXCLAW_WORKSPACE_ROOT` must be visible on both sides until path mapping
     exists.

2. Add `.dockerignore`.
   - Dependencies: task 1.
   - Expected exclusions: `.env`, `.env.*`, local state directories, token and
     SQLite files, dependency caches, git metadata where appropriate, temporary
     smoke workspaces, logs, and generated runtime data.
   - Validation: Docker build context does not include codexclaw secrets,
     SQLite state, or host-local runtime data.

3. Add a reference `Dockerfile` for `codex app-server`.
   - Dependencies: task 2 and the pinned Codex CLI version in `package.json`.
   - Expected properties: installs or otherwise pins Codex CLI `0.128.0`, runs
     as a non-root user, exposes only the intended app-server port, accepts a
     read-only token file path, uses a caller-provided workspace mount, and does
     not copy codexclaw state into the image.
   - Validation: image builds from a fresh clone and can start `codex app-server`
     with `--ws-auth capability-token` and `--ws-token-file`.

4. Define app-server container Codex authentication.
   - Dependencies: task 3 and PRD section 5.3 credential-boundary rules.
   - Expected properties: either a narrowly scoped read-only Codex
     secret/config mount or an isolated container-owned config volume initialized
     by a documented `codex login` step. The plan must not require mounting
     broad `$HOME`, cloud credential directories, SSH agents, Docker sockets, or
     unrelated host secrets.
   - Validation: authenticated smoke distinguishes missing Codex auth from
     app-server readiness and confirms no broad credential mounts are present.

5. Add Docker run or compose artifacts.
   - Dependencies: tasks 3-4.
   - Expected properties: loopback-only publish such as
     `127.0.0.1:4500:4500`, workspace bind mount at the same absolute path as
     host codexclaw, read-only single-file token mount, no codexclaw state or
     SQLite mount into app-server, selected `CodexAuthMode` mount or volume
     behavior, non-root user wiring where practical, and a container-internal
     app-server listener that Docker port forwarding or the internal network can
     actually reach.
   - Validation: `/readyz` succeeds from the host without exposing plaintext
     `ws://` on non-loopback interfaces, and runtime inspection shows no
     `0.0.0.0` host publish for plaintext app-server access.

6. Add Apple Container guidance or artifact after spike.
   - Dependencies: task 3.
   - Expected properties: state whether Apple Container can build/run the same
     image artifact or needs a separate command path; avoid claiming support
     until a smoke run verifies it.
   - Validation: docs label Apple Container as `smoke_verified` only if build,
     run, `/readyz`, host-side CLI `/thread list`, `/skills list`, and `/quit`
     are exercised in that runtime. If Codex credentials are available, include
     one minimal prompt.

7. Update docs and release checklist.
   - Dependencies: tasks 3-6.
   - Expected changes: `docs/deploy/container.md`,
     `docs/M4-manual-checklist.md`, README, and possibly `.env.example`.
   - Validation: M4 checklist section 3 has concrete build/run/readiness checks
     and a clear fallback or blocked status when no supported runtime is
     installed.

8. Add validation commands and smoke expectations.
   - Dependencies: tasks 3-7.
   - Expected validation: `bun run schema:verify`, `bun run typecheck`,
     `bun test`, Docker build, container `/readyz`, and host-side CLI
     `/thread list`, `/skills list`, and `/quit` against the containerized
     app-server. If Codex credentials are available, include one minimal prompt
     round trip.
   - Validation: failure modes distinguish missing runtime, build failure,
     unsafe publish, token permission failure, app-server readiness failure,
     missing Codex authentication, schema/protocol mismatch, and workspace path
     mismatch.

## Dependencies

- Docker Engine/Desktop or a compatible build/run runtime for smoke validation.
- Apple Container CLI for Apple-specific smoke validation, if available.
- Pinned Codex CLI version from `package.json`.
- Existing `scripts/start-codex-app-server.sh` behavior for parity, not as the
  primary container entrypoint if it assumes host-local loopback helper semantics.
- Existing env validation in `src/config/env.ts` and installer behavior in
  `codexclaw.sh`.
- Codex CLI authentication material or login flow scoped narrowly to the
  app-server container runtime.

## Files Or Modules Expected To Change

- `.dockerignore`
- `Dockerfile`
- `compose.yaml` or `docker-compose.yml`, if compose is chosen
- `scripts/start-codex-container.sh`, only if a script is clearer than compose
  for safe defaults
- `docs/deploy/container.md`
- `docs/M4-manual-checklist.md`
- `README.md`
- `.env.example`, if new env examples are needed

## Type And Interface Sketches

```ts
type ContainerRuntime = "docker" | "apple_container";
type ContainerSupportLevel = "smoke_verified" | "documented_only";
type ContainerMountRole = "workspace" | "token";
type HostOwnedPathRole = "state" | "db";
type NetworkExposure = "loopback_publish" | "internal_network" | "reverse_proxy_wss";
type CodexAuthMode = "readonly_secret_mount" | "isolated_container_login_volume";

interface ContainerArtifactDecision {
  runtime: ContainerRuntime;
  supportLevel: ContainerSupportLevel;
  buildArtifact: string;
  runArtifact: string;
  codexAuthMode: CodexAuthMode;
  validation: readonly ContainerValidationStep[];
}

type ContainerValidationStep =
  | "build"
  | "readyz"
  | "schema_verify"
  | "typecheck"
  | "tests"
  | "thread_list"
  | "skills_list"
  | "cli_quit"
  | "minimal_prompt";
```

## Pseudocode

```text
prepare app-server container:
  require absolute host workspace path
  require token file outside workspace
  bind workspace at the same absolute path inside container
  bind token as read-only single file
  provide Codex CLI auth through a narrow secret mount or isolated login volume
  do not bind codexclaw state directory
  do not bind codexclaw SQLite database
  run app-server as non-root user
  listen on a container-reachable interface
  publish app-server only on host 127.0.0.1 or keep it internal

validate container smoke:
  build image
  start app-server container
  check /readyz from host
  run host codexclaw CLI against ws://127.0.0.1:4500
  send /thread list
  send /skills list
  send /quit
  if Codex auth is available:
    send one minimal prompt
  stop container
```

## Validation Criteria

- Fresh clone can build the reference Docker image.
- Docker run or compose path starts `codex app-server` without mounting
  codexclaw state or SQLite into the app-server container.
- Host can reach `/readyz` through loopback-only publish or through WSS proxy.
- Host-side `bun run cli` can connect to the containerized app-server and run
  `/thread list`, `/skills list`, and `/quit` cleanly.
- If Codex credentials are available in the selected container auth mode,
  host-side CLI can complete one minimal prompt against the containerized
  app-server.
- `docker ps` or equivalent inspection shows no plaintext app-server publish on
  `0.0.0.0`.
- Container-internal app-server listen address is reachable through the selected
  Docker publish or internal network while host exposure remains loopback-only
  or WSS-only.
- Token file remains private on the host and read-only in the app-server
  container.
- Codex CLI auth/config is not supplied by broad `$HOME`, cloud credential,
  Docker socket, SSH agent, or unrelated host-secret mounts.
- `bun run schema:verify`, `bun run typecheck`, and `bun test` still pass.
- Apple Container docs do not claim smoke-verified support without an actual
  runtime smoke.

## Risks And Unknowns

- Codex CLI install method inside the image may require network or package
  naming details that differ by environment. Smallest spike: build the image and
  run `codex --version` inside it.
- Codex CLI authentication inside the app-server container may require a
  supported non-interactive or isolated login path. Smallest spike: initialize an
  isolated container auth volume or narrow secret mount and run an authenticated
  `thread/list` plus minimal prompt smoke.
- Binding `codex app-server` to container-local `127.0.0.1` may break Docker
  port forwarding even when the host publish is loopback-only. Smallest spike:
  verify the container-internal listener and host `127.0.0.1:4500` `/readyz`
  together.
- Apple Container compatibility is unknown in this workspace. Smallest spike:
  run the same image or equivalent command path with Apple Container and record
  exact commands.
- UID/GID behavior differs across macOS Docker Desktop, Linux Docker, and Apple
  Container. Smallest spike: write one disposable workspace file as the
  app-server user and verify token remains read-only.
- Current lack of path mapping requires same absolute workspace paths on host
  and in container. Mitigation: document that constraint and defer general path
  mapping.
- A compose file can make unsafe ports look convenient. Mitigation: default only
  to loopback publish and add validation that rejects or flags non-loopback
  plaintext examples.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | planner | 2026-05-11 | draft | Proposed bounded Docker/container artifact plan after M4 checklist section 3 was blocked. |
| 1 | implementation-reviewer | 2026-05-11 | fixes applied | Added container Codex auth boundary, stronger CLI smoke, and container-internal listener validation. |
| 2 | implementation-reviewer | 2026-05-11 | fixes applied | Aligned Apple Container smoke with Docker smoke and made run artifacts depend on selected Codex auth mode. |
