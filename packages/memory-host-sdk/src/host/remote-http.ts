// Memory Host SDK module implements remote http behavior.
import {
  fetchWithSsrFGuard,
  shouldUseEnvHttpProxyForUrl,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "./openclaw-runtime-network.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

// Remote memory HTTP wrapper that applies SSRF policy and releases guarded sockets.

/** Proxy mode used only for URLs that the runtime classified as env-proxy safe. */
const MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE = "trusted_env_proxy";

/**
 * Hosted remote memory HTTP hang floor (OpenAI/Voyage/Google batch/query budgets).
 * Matches EMBEDDING_BATCH_TIMEOUT_REMOTE_MS in memory-core manager-embedding-ops.
 */
export const MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS = 120_000;

/**
 * Local/self-hosted remote memory HTTP hang floor (Ollama/LM Studio batch budget).
 * Matches EMBEDDING_BATCH_TIMEOUT_LOCAL_MS (10 minutes) so a shared hang guard cannot
 * clamp established self-hosted embedding requests that legitimately take 2–10 minutes.
 * Composed with any caller AbortSignal via fetchWithSsrFGuard so cancellation-only
 * signals cannot disable the floor; hosted callers pass timeoutMs:
 * MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS when they want the tighter budget.
 * Kept package-private — only MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS is a public contract.
 */
const MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS = 600_000;

/** Default hang floor preserves the longer self-hosted budget for compatibility. */
const MEMORY_REMOTE_HTTP_TIMEOUT_MS = MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS;

/** Build an SSRF allow policy from a configured remote base URL. */
export const buildRemoteBaseUrlPolicy: (baseUrl: string) => SsrFPolicy | undefined =
  ssrfPolicyFromHttpBaseUrlAllowedHostname;

/** Execute a remote HTTP request under SSRF guard and always release the response handle. */
export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  /** Override the hang floor; defaults to MEMORY_REMOTE_HTTP_TIMEOUT_LOCAL_MS. */
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  fetchWithSsrFGuardImpl?: typeof fetchWithSsrFGuard;
  shouldUseEnvHttpProxyForUrlImpl?: typeof shouldUseEnvHttpProxyForUrl;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const guardedFetch = params.fetchWithSsrFGuardImpl ?? fetchWithSsrFGuard;
  const shouldUseEnvProxy = params.shouldUseEnvHttpProxyForUrlImpl ?? shouldUseEnvHttpProxyForUrl;
  // Always install a hang floor; fetchWithSsrFGuard composes it with caller signals.
  const timeoutMs = params.timeoutMs ?? MEMORY_REMOTE_HTTP_TIMEOUT_MS;
  const { response, release } = await guardedFetch({
    url: params.url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    signal: params.signal,
    timeoutMs,
    policy: params.ssrfPolicy,
    auditContext: params.auditContext ?? "memory-remote",
    ...(shouldUseEnvProxy(params.url) ? { mode: MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE } : {}),
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}

/**
 * Hosted/cloud memory HTTP wrapper. Applies the 120s hosted hang floor unless the
 * caller passes an explicit timeoutMs. Local/self-hosted callers should keep using
 * withRemoteHttpResponse so they retain the longer default budget.
 */
export async function withHostedRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  fetchWithSsrFGuardImpl?: typeof fetchWithSsrFGuard;
  shouldUseEnvHttpProxyForUrlImpl?: typeof shouldUseEnvHttpProxyForUrl;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    ...params,
    timeoutMs: params.timeoutMs ?? MEMORY_REMOTE_HTTP_TIMEOUT_HOSTED_MS,
  });
}
