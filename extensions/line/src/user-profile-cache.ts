import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";

const LINE_USER_PROFILE_CACHE_MAX_ENTRIES = 1024;
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const LINE_USER_PROFILE_CACHE_TEST_API = Symbol.for("openclaw.lineUserProfileCacheTestApi");

type LineUserProfileCacheEntry = {
  displayName: string;
  pictureUrl?: string;
  fetchedAt: number;
};

const userProfileCache = new Map<string, LineUserProfileCacheEntry>();

type LineUserProfileCacheTestApi = {
  reset(): void;
};

(globalThis as Record<PropertyKey, unknown>)[LINE_USER_PROFILE_CACHE_TEST_API] = {
  reset() {
    userProfileCache.clear();
  },
} satisfies LineUserProfileCacheTestApi;

function touchLineUserProfileCache(userId: string, value: LineUserProfileCacheEntry): void {
  // Delete + set refreshes Map insertion order so active users survive pruneMapToMaxSize
  // eviction (same LRU-on-access pattern as Slack conversation-info cache).
  userProfileCache.delete(userId);
  userProfileCache.set(userId, value);
  pruneMapToMaxSize(userProfileCache, LINE_USER_PROFILE_CACHE_MAX_ENTRIES);
}

export function readCachedLineUserProfile(
  userId: string,
): { displayName: string; pictureUrl?: string } | undefined {
  const cached = userProfileCache.get(userId);
  if (!cached || Date.now() - cached.fetchedAt >= PROFILE_CACHE_TTL_MS) {
    return undefined;
  }
  touchLineUserProfileCache(userId, cached);
  return { displayName: cached.displayName, pictureUrl: cached.pictureUrl };
}

export function writeCachedLineUserProfile(
  userId: string,
  profile: { displayName: string; pictureUrl?: string },
): void {
  touchLineUserProfileCache(userId, { ...profile, fetchedAt: Date.now() });
}
