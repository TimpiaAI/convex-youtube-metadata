import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_QUOTA_LIMIT = 10_000; // YouTube API daily quota
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const QUOTA_COST_PER_VIDEO = 1; // videos.list costs 1 unit per call (up to 50 IDs)

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Generate a unique reservation ID.
 */
function generateReservationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Ensure the rate limiter singleton exists and reset window if expired.
 */
async function getOrCreateRateLimiter(ctx: any) {
  const existing = await ctx.db.query("rateLimiter").first();
  const now = Date.now();

  if (existing) {
    // Reset window if expired
    if (now - existing.windowStart >= QUOTA_WINDOW_MS) {
      await ctx.db.patch(existing._id, {
        quotaUsed: 0,
        windowStart: now,
        reservations: 0,
      });
      return { ...existing, quotaUsed: 0, windowStart: now, reservations: 0 };
    }
    return existing;
  }

  // Create singleton
  const id = await ctx.db.insert("rateLimiter", {
    quotaUsed: 0,
    quotaLimit: DEFAULT_QUOTA_LIMIT,
    windowStart: now,
    reservations: 0,
  });

  return {
    _id: id,
    quotaUsed: 0,
    quotaLimit: DEFAULT_QUOTA_LIMIT,
    windowStart: now,
    reservations: 0,
  };
}

/**
 * Ensure the cache stats singleton exists.
 */
async function getOrCreateStats(ctx: any) {
  const existing = await ctx.db.query("cacheStats").first();

  if (existing) return existing;

  const id = await ctx.db.insert("cacheStats", {
    hits: 0,
    misses: 0,
    totalRequests: 0,
  });

  return { _id: id, hits: 0, misses: 0, totalRequests: 0 };
}

// ─── Cache Lookups ──────────────────────────────────────────────

/**
 * Get cached metadata for a single video.
 * Returns null if not cached or stale.
 */
export const getCachedVideo = query({
  args: {
    videoId: v.string(),
  },
  returns: v.union(
    v.object({
      videoId: v.string(),
      title: v.string(),
      description: v.string(),
      thumbnailUrl: v.string(),
      duration: v.string(),
      channelId: v.string(),
      channelTitle: v.string(),
      publishedAt: v.string(),
      viewCount: v.string(),
      likeCount: v.string(),
      cachedAt: v.number(),
      ttl: v.number(),
      fresh: v.boolean(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("videos")
      .withIndex("by_videoId", (q: any) => q.eq("videoId", args.videoId))
      .first();

    if (!record) return null;

    const now = Date.now();
    const fresh = now - record.cachedAt < record.ttl;

    return {
      videoId: record.videoId,
      title: record.title,
      description: record.description,
      thumbnailUrl: record.thumbnailUrl,
      duration: record.duration,
      channelId: record.channelId,
      channelTitle: record.channelTitle,
      publishedAt: record.publishedAt,
      viewCount: record.viewCount,
      likeCount: record.likeCount,
      cachedAt: record.cachedAt,
      ttl: record.ttl,
      fresh,
    };
  },
});

/**
 * Get cached metadata for multiple videos.
 * Returns an array of results (null for missing/stale entries).
 */
export const getCachedVideos = query({
  args: {
    videoIds: v.array(v.string()),
  },
  returns: v.array(
    v.union(
      v.object({
        videoId: v.string(),
        title: v.string(),
        description: v.string(),
        thumbnailUrl: v.string(),
        duration: v.string(),
        channelId: v.string(),
        channelTitle: v.string(),
        publishedAt: v.string(),
        viewCount: v.string(),
        likeCount: v.string(),
        cachedAt: v.number(),
        ttl: v.number(),
        fresh: v.boolean(),
      }),
      v.null()
    )
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const results: any[] = [];

    for (const videoId of args.videoIds) {
      const record = await ctx.db
        .query("videos")
        .withIndex("by_videoId", (q: any) => q.eq("videoId", videoId))
        .first();

      if (!record) {
        results.push(null);
        continue;
      }

      const fresh = now - record.cachedAt < record.ttl;

      results.push({
        videoId: record.videoId,
        title: record.title,
        description: record.description,
        thumbnailUrl: record.thumbnailUrl,
        duration: record.duration,
        channelId: record.channelId,
        channelTitle: record.channelTitle,
        publishedAt: record.publishedAt,
        viewCount: record.viewCount,
        likeCount: record.likeCount,
        cachedAt: record.cachedAt,
        ttl: record.ttl,
        fresh,
      });
    }

    return results;
  },
});

// ─── Cache Write ────────────────────────────────────────────────

/**
 * Store fetched video metadata in the cache.
 * Upserts by videoId — updates existing entries.
 */
export const storeVideo = mutation({
  args: {
    videoId: v.string(),
    title: v.string(),
    description: v.string(),
    thumbnailUrl: v.string(),
    duration: v.string(),
    channelId: v.string(),
    channelTitle: v.string(),
    publishedAt: v.string(),
    viewCount: v.string(),
    likeCount: v.string(),
    ttl: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const ttl = args.ttl ?? DEFAULT_TTL_MS;

    const existing = await ctx.db
      .query("videos")
      .withIndex("by_videoId", (q: any) => q.eq("videoId", args.videoId))
      .first();

    const data = {
      videoId: args.videoId,
      title: args.title,
      description: args.description,
      thumbnailUrl: args.thumbnailUrl,
      duration: args.duration,
      channelId: args.channelId,
      channelTitle: args.channelTitle,
      publishedAt: args.publishedAt,
      viewCount: args.viewCount,
      likeCount: args.likeCount,
      cachedAt: now,
      ttl,
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("videos", data);
    }

    return null;
  },
});

/**
 * Store multiple videos in a single mutation.
 */
export const storeVideos = mutation({
  args: {
    videos: v.array(
      v.object({
        videoId: v.string(),
        title: v.string(),
        description: v.string(),
        thumbnailUrl: v.string(),
        duration: v.string(),
        channelId: v.string(),
        channelTitle: v.string(),
        publishedAt: v.string(),
        viewCount: v.string(),
        likeCount: v.string(),
      })
    ),
    ttl: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const ttl = args.ttl ?? DEFAULT_TTL_MS;

    for (const video of args.videos) {
      const existing = await ctx.db
        .query("videos")
        .withIndex("by_videoId", (q: any) => q.eq("videoId", video.videoId))
        .first();

      const data = {
        ...video,
        cachedAt: now,
        ttl,
      };

      if (existing) {
        await ctx.db.patch(existing._id, data);
      } else {
        await ctx.db.insert("videos", data);
      }
    }

    return null;
  },
});

// ─── Rate Limiter ───────────────────────────────────────────────

/**
 * Check if quota is available and consume units.
 * Returns { allowed: true } if within quota, or { allowed: false, retryAfterMs }.
 */
export const consumeQuota = mutation({
  args: {
    units: v.optional(v.number()),
  },
  returns: v.object({
    allowed: v.boolean(),
    retryAfterMs: v.optional(v.number()),
    quotaUsed: v.number(),
    quotaLimit: v.number(),
  }),
  handler: async (ctx, args) => {
    const units = args.units ?? QUOTA_COST_PER_VIDEO;
    const limiter = await getOrCreateRateLimiter(ctx);

    if (limiter.quotaUsed + units > limiter.quotaLimit) {
      const elapsed = Date.now() - limiter.windowStart;
      const retryAfterMs = Math.max(0, QUOTA_WINDOW_MS - elapsed);
      return {
        allowed: false,
        retryAfterMs,
        quotaUsed: limiter.quotaUsed,
        quotaLimit: limiter.quotaLimit,
      };
    }

    await ctx.db.patch(limiter._id, {
      quotaUsed: limiter.quotaUsed + units,
    });

    return {
      allowed: true,
      quotaUsed: limiter.quotaUsed + units,
      quotaLimit: limiter.quotaLimit,
    };
  },
});

/**
 * Create a reservation for quota that will be consumed later.
 * Used when a request needs to wait for quota availability.
 */
export const createReservation = mutation({
  args: {
    videoIds: v.array(v.string()),
    timeoutMs: v.optional(v.number()),
  },
  returns: v.object({
    reservationId: v.string(),
    deadline: v.number(),
    quotaCost: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const timeoutMs = args.timeoutMs ?? 10_000; // default 10s
    const deadline = now + timeoutMs;
    const quotaCost = QUOTA_COST_PER_VIDEO; // batch lookup = 1 API call
    const reservationId = generateReservationId();

    const limiter = await getOrCreateRateLimiter(ctx);

    await ctx.db.patch(limiter._id, {
      reservations: limiter.reservations + 1,
    });

    await ctx.db.insert("reservationQueue", {
      reservationId,
      videoIds: args.videoIds,
      quotaCost,
      createdAt: now,
      deadline,
      status: "pending",
    });

    return { reservationId, deadline, quotaCost };
  },
});

/**
 * Try to fulfill a reservation — consume quota if available.
 */
export const fulfillReservation = mutation({
  args: {
    reservationId: v.string(),
  },
  returns: v.object({
    fulfilled: v.boolean(),
    expired: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("reservationQueue")
      .withIndex("by_reservationId", (q: any) =>
        q.eq("reservationId", args.reservationId)
      )
      .first();

    if (!reservation || reservation.status !== "pending") {
      return { fulfilled: false, expired: true };
    }

    const now = Date.now();

    // Check if reservation has timed out
    if (now > reservation.deadline) {
      await ctx.db.patch(reservation._id, { status: "expired" });

      const limiter = await getOrCreateRateLimiter(ctx);
      await ctx.db.patch(limiter._id, {
        reservations: Math.max(0, limiter.reservations - 1),
      });

      return { fulfilled: false, expired: true };
    }

    // Try to consume quota
    const limiter = await getOrCreateRateLimiter(ctx);
    if (limiter.quotaUsed + reservation.quotaCost > limiter.quotaLimit) {
      return { fulfilled: false, expired: false };
    }

    // Consume quota and fulfill
    await ctx.db.patch(limiter._id, {
      quotaUsed: limiter.quotaUsed + reservation.quotaCost,
      reservations: Math.max(0, limiter.reservations - 1),
    });

    await ctx.db.patch(reservation._id, { status: "fulfilled" });

    return { fulfilled: true, expired: false };
  },
});

/**
 * Cancel a pending reservation.
 */
export const cancelReservation = mutation({
  args: {
    reservationId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("reservationQueue")
      .withIndex("by_reservationId", (q: any) =>
        q.eq("reservationId", args.reservationId)
      )
      .first();

    if (!reservation || reservation.status !== "pending") return false;

    await ctx.db.patch(reservation._id, { status: "expired" });

    const limiter = await getOrCreateRateLimiter(ctx);
    await ctx.db.patch(limiter._id, {
      reservations: Math.max(0, limiter.reservations - 1),
    });

    return true;
  },
});

// ─── Cache Stats ────────────────────────────────────────────────

/**
 * Record a cache hit.
 */
export const recordHit = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const stats = await getOrCreateStats(ctx);
    await ctx.db.patch(stats._id, {
      hits: stats.hits + 1,
      totalRequests: stats.totalRequests + 1,
    });
    return null;
  },
});

/**
 * Record a cache miss.
 */
export const recordMiss = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const stats = await getOrCreateStats(ctx);
    await ctx.db.patch(stats._id, {
      misses: stats.misses + 1,
      totalRequests: stats.totalRequests + 1,
    });
    return null;
  },
});

/**
 * Get cache statistics.
 */
export const getCacheStats = query({
  args: {},
  returns: v.object({
    hits: v.number(),
    misses: v.number(),
    totalRequests: v.number(),
    hitRate: v.number(),
    quotaUsed: v.number(),
    quotaLimit: v.number(),
    activeReservations: v.number(),
    quotaWindowStart: v.number(),
  }),
  handler: async (ctx) => {
    // Stats
    const stats = await ctx.db.query("cacheStats").first();
    const hits = stats?.hits ?? 0;
    const misses = stats?.misses ?? 0;
    const totalRequests = stats?.totalRequests ?? 0;
    const hitRate = totalRequests > 0 ? hits / totalRequests : 0;

    // Rate limiter
    const limiter = await ctx.db.query("rateLimiter").first();
    const now = Date.now();
    let quotaUsed = limiter?.quotaUsed ?? 0;
    const quotaLimit = limiter?.quotaLimit ?? DEFAULT_QUOTA_LIMIT;
    const windowStart = limiter?.windowStart ?? now;
    const activeReservations = limiter?.reservations ?? 0;

    // Check if window has expired (read-only, don't reset here)
    if (limiter && now - limiter.windowStart >= QUOTA_WINDOW_MS) {
      quotaUsed = 0;
    }

    return {
      hits,
      misses,
      totalRequests,
      hitRate,
      quotaUsed,
      quotaLimit,
      activeReservations,
      quotaWindowStart: windowStart,
    };
  },
});

// ─── Cache Management ───────────────────────────────────────────

/**
 * Clear all cached video entries.
 */
export const clearCache = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const videos = await ctx.db.query("videos").collect();
    let deleted = 0;

    for (const video of videos) {
      await ctx.db.delete(video._id);
      deleted++;
    }

    // Reset stats
    const stats = await ctx.db.query("cacheStats").first();
    if (stats) {
      await ctx.db.patch(stats._id, {
        hits: 0,
        misses: 0,
        totalRequests: 0,
      });
    }

    return deleted;
  },
});

/**
 * Remove stale cache entries (older than their TTL).
 */
export const cleanupStale = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const videos = await ctx.db.query("videos").collect();
    let deleted = 0;

    for (const video of videos) {
      if (now - video.cachedAt >= video.ttl) {
        await ctx.db.delete(video._id);
        deleted++;
      }
    }

    // Also clean up expired reservations
    const reservations = await ctx.db
      .query("reservationQueue")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();

    for (const reservation of reservations) {
      if (now > reservation.deadline) {
        await ctx.db.patch(reservation._id, { status: "expired" });
      }
    }

    return deleted;
  },
});

/**
 * Set the quota limit for the rate limiter.
 */
export const setQuotaLimit = mutation({
  args: {
    quotaLimit: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const limiter = await getOrCreateRateLimiter(ctx);
    await ctx.db.patch(limiter._id, { quotaLimit: args.quotaLimit });
    return null;
  },
});

/**
 * Reset the rate limiter quota (start fresh window).
 */
export const resetQuota = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const limiter = await getOrCreateRateLimiter(ctx);
    await ctx.db.patch(limiter._id, {
      quotaUsed: 0,
      windowStart: Date.now(),
      reservations: 0,
    });
    return null;
  },
});
