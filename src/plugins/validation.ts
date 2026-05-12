import {
  MAX_PLUGIN_ARGS,
  MAX_PLUGIN_DESCRIPTION_LENGTH,
  MAX_PLUGIN_DISPLAY_LENGTH,
  MAX_PLUGIN_ENV_VARS,
  MAX_PLUGIN_PROVIDER_LENGTH,
  MAX_PLUGIN_TOOLS,
  diagnostic,
  isPlainRecord,
  isSensitiveEnvName,
  isValidArgValue,
  isValidCommandPath,
  isValidEnvName,
  isValidPluginId,
  isValidServerName,
  isValidToolName,
  rejectUnknownFields,
  sanitizeDisplayString,
  summarizeUntrustedValue
} from "./security.js";
import {
  PLUGIN_DESCRIPTOR_SCHEMA_VERSION,
  type PluginDescriptorSummary,
  type PluginDescriptorValidationResult,
  type PluginToolSummary,
  type PluginValidationDiagnostic,
  type ValidatedPluginDescriptor,
  type ValidatedPluginEnvVar
} from "./types.js";

export function validatePluginDescriptor(input: unknown): PluginDescriptorValidationResult {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const parsed = parsePluginDescriptor(input, diagnostics);
  if (!parsed || diagnostics.length > 0) return { ok: false, diagnostics };

  const summary = summarizePluginDescriptor(parsed);
  return { ok: true, descriptor: parsed, summary };
}

export function summarizePluginDescriptor(descriptor: ValidatedPluginDescriptor): PluginDescriptorSummary {
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    version: descriptor.version,
    description: descriptor.description,
    serverName: descriptor.mcp.serverName,
    tools: descriptor.tools.map((tool) => ({ ...tool })),
    security: {
      network: descriptor.security.network,
      providers: [...descriptor.security.providers],
      envNames: [...descriptor.security.envAllowlist],
      elicitation: "fail_closed"
    }
  };
}

function parsePluginDescriptor(
  input: unknown,
  diagnostics: PluginValidationDiagnostic[]
): ValidatedPluginDescriptor | undefined {
  if (!isPlainRecord(input)) {
    diagnostics.push(diagnostic("$", "invalid_type", "Plugin descriptor must be an object"));
    return undefined;
  }

  rejectUnknownFields(
    input,
    ["schemaVersion", "id", "displayName", "version", "description", "mcp", "tools", "security"],
    "$",
    diagnostics
  );

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== PLUGIN_DESCRIPTOR_SCHEMA_VERSION) {
    diagnostics.push(diagnostic("$.schemaVersion", "invalid_schema_version", "Plugin descriptor schemaVersion must be 1"));
  }

  const id = parseIdentifier(input.id, "$.id", diagnostics);
  const displayName = parseBoundedString(input.displayName, "$.displayName", MAX_PLUGIN_DISPLAY_LENGTH, diagnostics);
  const version = parseOptionalBoundedString(input.version, "$.version", 80, diagnostics);
  const description = parseOptionalBoundedString(input.description, "$.description", MAX_PLUGIN_DESCRIPTION_LENGTH, diagnostics);
  const mcp = parseMcp(input.mcp, diagnostics);
  const tools = parseTools(input.tools, diagnostics);
  const security = parseSecurity(input.security, mcp?.env ?? [], diagnostics);

  if (!id || !displayName || !mcp || !tools || !security || diagnostics.length > 0) return undefined;

  return {
    schemaVersion: PLUGIN_DESCRIPTOR_SCHEMA_VERSION,
    id,
    displayName,
    version,
    description,
    mcp,
    tools,
    security: {
      ...security,
      elicitation: "fail_closed"
    }
  };
}

function parseMcp(
  input: unknown,
  diagnostics: PluginValidationDiagnostic[]
): ValidatedPluginDescriptor["mcp"] | undefined {
  if (!isPlainRecord(input)) {
    diagnostics.push(diagnostic("$.mcp", "invalid_type", "mcp must be an object"));
    return undefined;
  }
  rejectUnknownFields(input, ["serverName", "command", "args", "env"], "$.mcp", diagnostics);

  const serverNameRaw = input.serverName;
  if (typeof serverNameRaw !== "string" || !isValidServerName(serverNameRaw)) {
    diagnostics.push(diagnostic("$.mcp.serverName", "invalid_identifier", "mcp.serverName must be a bounded MCP server name"));
  }
  const serverName = typeof serverNameRaw === "string" ? sanitizeDisplayString(serverNameRaw, 80) : undefined;

  const commandRaw = input.command;
  if (typeof commandRaw !== "string" || !isValidCommandPath(commandRaw)) {
    diagnostics.push(
      diagnostic(
        "$.mcp.command",
        "invalid_command",
        `mcp.command must be an absolute literal path without shell syntax; got ${summarizeUntrustedValue(commandRaw)}`
      )
    );
  }
  const command = typeof commandRaw === "string" ? commandRaw : undefined;

  const args = parseArgs(input.args, diagnostics);
  const env = parseEnv(input.env, diagnostics);

  if (!serverName || !command || !args || !env) return undefined;
  return { serverName, command, args, env };
}

function parseArgs(input: unknown, diagnostics: PluginValidationDiagnostic[]): readonly string[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    diagnostics.push(diagnostic("$.mcp.args", "invalid_type", "mcp.args must be an array of argv strings"));
    return undefined;
  }
  if (input.length > MAX_PLUGIN_ARGS) {
    diagnostics.push(diagnostic("$.mcp.args", "invalid_argument", `mcp.args must contain at most ${MAX_PLUGIN_ARGS} entries`));
  }

  const args: string[] = [];
  for (const [index, value] of input.entries()) {
    if (typeof value !== "string" || !isValidArgValue(value)) {
      diagnostics.push(
        diagnostic(`$.mcp.args[${index}]`, "invalid_argument", "mcp.args entries must be bounded strings without control characters")
      );
      continue;
    }
    args.push(value);
  }
  return args;
}

function parseEnv(input: unknown, diagnostics: PluginValidationDiagnostic[]): readonly ValidatedPluginEnvVar[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    diagnostics.push(diagnostic("$.mcp.env", "invalid_type", "mcp.env must be an array of env declarations"));
    return undefined;
  }
  if (input.length > MAX_PLUGIN_ENV_VARS) {
    diagnostics.push(diagnostic("$.mcp.env", "invalid_env", `mcp.env must contain at most ${MAX_PLUGIN_ENV_VARS} entries`));
  }

  const seen = new Set<string>();
  const env: ValidatedPluginEnvVar[] = [];
  for (const [index, value] of input.entries()) {
    const path = `$.mcp.env[${index}]`;
    if (!isPlainRecord(value)) {
      diagnostics.push(diagnostic(path, "invalid_type", "mcp.env entries must be objects"));
      continue;
    }
    rejectUnknownFields(value, ["name", "required", "description"], path, diagnostics);

    const nameRaw = value.name;
    if (typeof nameRaw !== "string" || !isValidEnvName(nameRaw)) {
      diagnostics.push(diagnostic(`${path}.name`, "invalid_env", "env name must be an uppercase identifier"));
      continue;
    }
    if (isSensitiveEnvName(nameRaw)) {
      diagnostics.push(diagnostic(`${path}.name`, "sensitive_env", `env name '${nameRaw}' is not allowed for plugin forwarding`));
      continue;
    }
    if (seen.has(nameRaw)) {
      diagnostics.push(diagnostic(`${path}.name`, "duplicate", `duplicate env name '${nameRaw}'`));
      continue;
    }
    seen.add(nameRaw);

    const required = parseOptionalBoolean(value.required, `${path}.required`, diagnostics) ?? false;
    const description = parseOptionalBoundedString(value.description, `${path}.description`, MAX_PLUGIN_DESCRIPTION_LENGTH, diagnostics);
    env.push({ name: nameRaw, required, description });
  }
  return env;
}

function parseSecurity(
  input: unknown,
  env: readonly ValidatedPluginEnvVar[],
  diagnostics: PluginValidationDiagnostic[]
): ValidatedPluginDescriptor["security"] | undefined {
  if (!isPlainRecord(input)) {
    diagnostics.push(diagnostic("$.security", "invalid_type", "security must be an object"));
    return undefined;
  }
  rejectUnknownFields(input, ["network", "providers", "envAllowlist"], "$.security", diagnostics);

  const networkRaw = input.network;
  if (networkRaw !== "none" && networkRaw !== "declared") {
    diagnostics.push(diagnostic("$.security.network", "invalid_security", "security.network must be 'none' or 'declared'"));
  }
  const network = networkRaw === "declared" ? "declared" : "none";

  const providers = parseProviders(input.providers, network, diagnostics);
  const envAllowlist = parseEnvAllowlist(input.envAllowlist, env, diagnostics);
  if (!providers || !envAllowlist) return undefined;
  return { network, providers, envAllowlist, elicitation: "fail_closed" };
}

function parseProviders(
  input: unknown,
  network: "none" | "declared",
  diagnostics: PluginValidationDiagnostic[]
): readonly string[] | undefined {
  if (input === undefined) {
    if (network === "declared") {
      diagnostics.push(diagnostic("$.security.providers", "invalid_security", "providers are required when network is declared"));
    }
    return [];
  }
  if (!Array.isArray(input)) {
    diagnostics.push(diagnostic("$.security.providers", "invalid_type", "security.providers must be an array"));
    return undefined;
  }
  if (network === "none" && input.length > 0) {
    diagnostics.push(diagnostic("$.security.providers", "invalid_security", "providers are forbidden when network is none"));
  }
  if (network === "declared" && input.length === 0) {
    diagnostics.push(diagnostic("$.security.providers", "invalid_security", "providers are required when network is declared"));
  }

  const seen = new Set<string>();
  const providers: string[] = [];
  for (const [index, value] of input.entries()) {
    if (typeof value !== "string") {
      diagnostics.push(diagnostic(`$.security.providers[${index}]`, "invalid_type", "provider must be a string"));
      continue;
    }
    const provider = sanitizeDisplayString(value, MAX_PLUGIN_PROVIDER_LENGTH);
    if (!provider) {
      diagnostics.push(diagnostic(`$.security.providers[${index}]`, "invalid_security", "provider must not be empty"));
      continue;
    }
    if (seen.has(provider)) {
      diagnostics.push(diagnostic(`$.security.providers[${index}]`, "duplicate", `duplicate provider '${provider}'`));
      continue;
    }
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

function parseEnvAllowlist(
  input: unknown,
  env: readonly ValidatedPluginEnvVar[],
  diagnostics: PluginValidationDiagnostic[]
): readonly string[] | undefined {
  const declaredNames = new Set(env.map((item) => item.name));
  if (input === undefined) return [...declaredNames].sort();
  if (!Array.isArray(input)) {
    diagnostics.push(diagnostic("$.security.envAllowlist", "invalid_type", "security.envAllowlist must be an array"));
    return undefined;
  }

  const seen = new Set<string>();
  const allowlist: string[] = [];
  for (const [index, value] of input.entries()) {
    const path = `$.security.envAllowlist[${index}]`;
    if (typeof value !== "string" || !isValidEnvName(value)) {
      diagnostics.push(diagnostic(path, "invalid_env", "env allowlist entries must be uppercase identifiers"));
      continue;
    }
    if (isSensitiveEnvName(value)) {
      diagnostics.push(diagnostic(path, "sensitive_env", `env name '${value}' is not allowed for plugin forwarding`));
      continue;
    }
    if (!declaredNames.has(value)) {
      diagnostics.push(diagnostic(path, "invalid_env", `env name '${value}' must be declared in mcp.env`));
      continue;
    }
    if (seen.has(value)) {
      diagnostics.push(diagnostic(path, "duplicate", `duplicate env allowlist entry '${value}'`));
      continue;
    }
    seen.add(value);
    allowlist.push(value);
  }
  return allowlist.sort();
}

function parseTools(input: unknown, diagnostics: PluginValidationDiagnostic[]): readonly PluginToolSummary[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    diagnostics.push(diagnostic("$.tools", "invalid_type", "tools must be an array"));
    return undefined;
  }
  if (input.length > MAX_PLUGIN_TOOLS) {
    diagnostics.push(diagnostic("$.tools", "invalid_type", `tools must contain at most ${MAX_PLUGIN_TOOLS} entries`));
  }

  const seen = new Set<string>();
  const tools: PluginToolSummary[] = [];
  for (const [index, value] of input.entries()) {
    const path = `$.tools[${index}]`;
    if (!isPlainRecord(value)) {
      diagnostics.push(diagnostic(path, "invalid_type", "tool metadata entries must be objects"));
      continue;
    }
    rejectUnknownFields(value, ["name", "title", "description"], path, diagnostics);
    const nameRaw = value.name;
    if (typeof nameRaw !== "string" || !isValidToolName(nameRaw)) {
      diagnostics.push(diagnostic(`${path}.name`, "invalid_identifier", "tool name must be a bounded identifier"));
      continue;
    }
    if (seen.has(nameRaw)) {
      diagnostics.push(diagnostic(`${path}.name`, "duplicate", `duplicate tool name '${nameRaw}'`));
      continue;
    }
    seen.add(nameRaw);

    const title = parseOptionalBoundedString(value.title, `${path}.title`, MAX_PLUGIN_DISPLAY_LENGTH, diagnostics);
    const description = parseOptionalBoundedString(value.description, `${path}.description`, MAX_PLUGIN_DESCRIPTION_LENGTH, diagnostics);
    tools.push({ name: nameRaw, title, description });
  }
  return tools;
}

function parseIdentifier(input: unknown, path: string, diagnostics: PluginValidationDiagnostic[]): string | undefined {
  if (typeof input !== "string" || !isValidPluginId(input)) {
    diagnostics.push(diagnostic(path, "invalid_identifier", "plugin id must be lowercase, bounded, and path-free"));
    return undefined;
  }
  return input;
}

function parseBoundedString(
  input: unknown,
  path: string,
  maxLength: number,
  diagnostics: PluginValidationDiagnostic[]
): string | undefined {
  if (typeof input !== "string") {
    diagnostics.push(diagnostic(path, "invalid_type", `${path} must be a string`));
    return undefined;
  }
  const value = sanitizeDisplayString(input, maxLength);
  if (!value) {
    diagnostics.push(diagnostic(path, "invalid_type", `${path} must not be empty`));
    return undefined;
  }
  return value;
}

function parseOptionalBoundedString(
  input: unknown,
  path: string,
  maxLength: number,
  diagnostics: PluginValidationDiagnostic[]
): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") {
    diagnostics.push(diagnostic(path, "invalid_type", `${path} must be a string when present`));
    return undefined;
  }
  const value = sanitizeDisplayString(input, maxLength);
  return value || undefined;
}

function parseOptionalBoolean(
  input: unknown,
  path: string,
  diagnostics: PluginValidationDiagnostic[]
): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") {
    diagnostics.push(diagnostic(path, "invalid_type", `${path} must be a boolean when present`));
    return undefined;
  }
  return input;
}
