// Test-only helpers for the LINE user profile cache.
const LINE_USER_PROFILE_CACHE_TEST_API = Symbol.for("openclaw.lineUserProfileCacheTestApi");

type LineUserProfileCacheTestApi = {
  reset(): void;
};

export function resetLineUserProfileCacheForTests(): void {
  const api = (globalThis as Record<PropertyKey, unknown>)[LINE_USER_PROFILE_CACHE_TEST_API] as
    | LineUserProfileCacheTestApi
    | undefined;
  api?.reset();
}
