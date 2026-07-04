/**
 * Claude CLI provider discovery descriptor. It exposes subscription-backed
 * synthetic auth for catalog/runtime discovery without full Anthropic registration.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { readClaudeCliCredentialsForRuntime } from "./cli-auth-seam.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

function resolveClaudeCliSyntheticAuth() {
  const credential = readClaudeCliCredentialsForRuntime();
  if (!credential) {
    return undefined;
  }
  if (credential.type === "oauth") {
    return {
      apiKey: credential.access,
      source: "Claude CLI native auth",
      mode: "oauth" as const,
      expiresAt: credential.expires,
    };
  }
  if (credential.type === "token") {
    return {
      apiKey: credential.token,
      source: "Claude CLI native auth",
      mode: "token" as const,
      expiresAt: credential.expires,
    };
  }
  return {
    apiKey: credential.marker,
    source: "Claude CLI apiKeyHelper",
    mode: "api-key" as const,
  };
}

const anthropicProviderDiscovery: ProviderPlugin = {
  id: CLAUDE_CLI_BACKEND_ID,
  label: "Claude CLI",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: ({ provider }) =>
    provider === CLAUDE_CLI_BACKEND_ID ? resolveClaudeCliSyntheticAuth() : undefined,
};

export default anthropicProviderDiscovery;
