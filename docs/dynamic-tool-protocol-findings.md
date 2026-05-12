# Dynamic Tool Protocol Findings

Status: Phase 0 spike implemented; registration path unavailable in generated
client schema.

Date: 2026-05-12

## Scope

This document records codexclaw dynamic tool protocol evidence. It does not
authorize production host-side plugin execution.

The current permitted scope is:

- schema provenance and generated method inspection;
- live app-server probing for generated candidate methods;
- metadata-only response summaries;
- documenting whether a toy dynamic tool can be registered and called.

Production `DynamicToolRegistry`, production `DynamicToolBridge`, third-party
plugin loading, and OpenCandle provider integration remain blocked by
`docs/plans/2026-05-12-plugin-dynamic-tool-bridge.md`.

## Schema Provenance

`bun run schema:verify` passed on 2026-05-12 against the pinned
`codex-cli 0.128.0` and active root `schemas/generated`.

The active generated root currently contains nested `schemas/generated/v2`
files. The dynamic tool files under that nested directory are therefore
available for Phase 0 inspection, but production code must continue to rely on
the schema gate rather than assuming the nested layout is stable.

Relevant candidate files:

- `schemas/generated/ServerRequest.ts`
- `schemas/generated/v2/DynamicToolSpec.ts`
- `schemas/generated/v2/DynamicToolCallParams.ts`
- `schemas/generated/v2/DynamicToolCallResponse.ts`
- `schemas/generated/v2/DynamicToolCallOutputContentItem.ts`

## Generated Surface

Observed from generated schemas:

- `ServerRequest` includes `item/tool/call` with `DynamicToolCallParams`.
- `DynamicToolSpec` exists as a type with namespace, name, description, input
  schema, and deferred-loading metadata.
- `DynamicToolCallParams` includes thread id, turn id, call id, namespace, tool
  name, and JSON arguments.
- `DynamicToolCallResponse` includes content items and success state.
- `InitializeCapabilities` includes `experimentalApi`.

No generated client request, initialize, turn, config, profile, plugin, app, or
MCP schema has yet been confirmed as a client-sent `DynamicToolSpec`
registration path.

## Repeatable Probe

Run with an app-server already listening and the usual codexclaw connection
environment:

```bash
bun run spike:dynamic-tool
```

The probe:

- inspects generated dynamic tool references without logging raw tool payloads;
- connects once with initialize capabilities omitted;
- connects once with `experimentalApi: true`;
- requests metadata-only summaries from generated read/list methods:
  - `experimentalFeature/list`;
  - `plugin/list`;
  - `app/list`;
  - `config/read`;
- reports whether any response shape contains a dynamic-tool reference;
- exits successfully when no generated registration path is found, recording
  the outcome as `registration_unavailable_in_generated_client_schema`.

If future schemas expose a registration candidate, the probe fails and must be
extended before Phase 0 can be marked complete.

## Current Outcome

`bun run spike:dynamic-tool` was run against a live local app-server on
2026-05-12 using an isolated temporary token and port `4510`.

Observed result:

- dynamic call request shape exists;
- client-sent registration path was not found in generated client schemas;
- initialize with omitted capabilities succeeded;
- initialize with `experimentalApi: true` succeeded;
- `experimentalFeature/list`, `plugin/list`, `app/list`, and `config/read`
  returned successfully under both initialize modes;
- those metadata responses did not contain a dynamic-tool reference in the
  probe's bounded recursive scan;
- live `item/tool/call` observation is skipped because there is no generated
  registration path to advertise a toy tool.

Phase 0 protocol result for pinned `codex-cli 0.128.0`:

- `item/tool/call` is present as a server request shape.
- `DynamicToolSpec` exists as a generated type.
- No generated client request or initialize/turn/config/plugin/app path exposes
  a confirmed client-side dynamic tool registration mechanism.

Therefore production host-side dynamic tool work remains blocked. The next
viable routes are:

- investigate Codex native plugin internals separately;
- investigate MCP server exposure as the app-server-supported tool path;
- or wait for a schema/app-server update that exposes a dynamic tool
  registration request.

## Storage And Security Boundary

The spike must not persist raw tool arguments, raw tool outputs, conversation
bodies, diffs, approval decisions, or approval histories.

codexclaw spike-owned logs are limited to:

- method names;
- response shape summaries;
- dynamic reference yes/no flags;
- event counts;
- bounded error shapes.

The app-server itself may emit its own plugin manifest warnings while servicing
`plugin/list`. Those are Codex-owned logs, not codexclaw persisted data.

The spike does not implement production host-side plugin execution and does not
load third-party code.
