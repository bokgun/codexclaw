# App-Server Schema Provenance

Status: active schema gate passed

The active app-server TypeScript schema is pinned to:

- Codex CLI/app-server version: `0.128.0`
- Version pin location: `package.json` field `codexclaw.codexCliVersion`
- Active schema directory: `schemas/generated`
- Generation command: `codex app-server generate-ts --out schemas/generated`
- Experimental schema generation: disabled
- Verification command: `bun run schema:verify`

`bun run schema:verify` checks the local `codex --version`, regenerates the
active schema into a temporary directory, and compares it to
`schemas/generated`. The checked-in `.gitkeep` file is ignored during the diff.

`schemas/generated/v2` is a legacy snapshot and is not part of the active M1
protocol source until it has separate provenance and a matching pinned generator.
M1 implementation must use `schemas/generated` plus live M0 observations as the
protocol source of truth.
