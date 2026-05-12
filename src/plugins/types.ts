export const PLUGIN_DESCRIPTOR_SCHEMA_VERSION = 1;

export type PluginNetworkAccess = "none" | "declared";

export interface PluginDescriptorV1 {
  schemaVersion: typeof PLUGIN_DESCRIPTOR_SCHEMA_VERSION;
  id: string;
  displayName: string;
  version?: string;
  description?: string;
  mcp: PluginMcpDescriptor;
  tools?: readonly PluginToolMetadata[];
  security: PluginSecurityDescriptor;
}

export interface PluginMcpDescriptor {
  serverName: string;
  command: string;
  args?: readonly string[];
  env?: readonly PluginEnvVar[];
}

export interface PluginEnvVar {
  name: string;
  required?: boolean;
  description?: string;
}

export interface PluginToolMetadata {
  name: string;
  title?: string;
  description?: string;
}

export interface PluginSecurityDescriptor {
  network: PluginNetworkAccess;
  providers?: readonly string[];
  envAllowlist?: readonly string[];
}

export interface ValidatedPluginDescriptor {
  schemaVersion: typeof PLUGIN_DESCRIPTOR_SCHEMA_VERSION;
  id: string;
  displayName: string;
  version?: string;
  description?: string;
  mcp: {
    serverName: string;
    command: string;
    args: readonly string[];
    env: readonly ValidatedPluginEnvVar[];
  };
  tools: readonly PluginToolSummary[];
  security: {
    network: PluginNetworkAccess;
    providers: readonly string[];
    envAllowlist: readonly string[];
    elicitation: "fail_closed";
  };
}

export interface ValidatedPluginEnvVar {
  name: string;
  required: boolean;
  description?: string;
}

export interface PluginDescriptorSummary {
  id: string;
  displayName: string;
  version?: string;
  description?: string;
  serverName: string;
  tools: readonly PluginToolSummary[];
  security: {
    network: PluginNetworkAccess;
    providers: readonly string[];
    envNames: readonly string[];
    elicitation: "fail_closed";
  };
}

export interface PluginToolSummary {
  name: string;
  title?: string;
  description?: string;
}

export interface PluginValidationDiagnostic {
  path: string;
  code:
    | "read_error"
    | "invalid_json"
    | "path_denied"
    | "missing"
    | "invalid_type"
    | "unknown_field"
    | "invalid_schema_version"
    | "invalid_identifier"
    | "invalid_command"
    | "invalid_argument"
    | "invalid_env"
    | "sensitive_env"
    | "invalid_security"
    | "duplicate";
  message: string;
}

export type PluginDescriptorValidationResult =
  | {
      ok: true;
      descriptor: ValidatedPluginDescriptor;
      summary: PluginDescriptorSummary;
    }
  | {
      ok: false;
      diagnostics: readonly PluginValidationDiagnostic[];
    };

export type LocalPluginStatus =
  | "available"
  | "invalid"
  | "duplicate"
  | "version_mismatch"
  | "missing_env";

export interface LocalPluginRegistry {
  entries: readonly LocalPluginRegistryEntry[];
  diagnostics: readonly PluginValidationDiagnostic[];
}

export interface LocalPluginRegistryEntry {
  id: string;
  version?: string;
  sourcePath: string;
  sourceLabel: string;
  summary?: PluginDescriptorSummary;
  descriptor?: ValidatedPluginDescriptor;
  enabled: boolean;
  status: LocalPluginStatus;
  diagnostics: readonly PluginValidationDiagnostic[];
  missingEnvNames: readonly string[];
}

export interface AppServerMcpConfigProjection {
  mcpServers: readonly AppServerMcpServerConfig[];
  omitted: readonly PluginProjectionOmission[];
}

export interface AppServerMcpServerConfig {
  serverName: string;
  command: string;
  args: readonly string[];
  env: readonly PluginRuntimeEnvVar[];
}

export interface PluginRuntimeEnvVar {
  name: string;
  value: string;
}

export interface PluginProjectionOmission {
  pluginId: string;
  sourceLabel: string;
  reason: "disabled" | "invalid" | "duplicate" | "version_mismatch" | "missing_env";
  missingEnvNames: readonly string[];
}
