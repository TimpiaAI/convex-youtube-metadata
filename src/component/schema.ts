import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Cached YouTube video metadata
  videos: defineTable({
    // YouTube video ID (e.g. "dQw4w9WgXcQ")
    videoId: v.string(),
    // Video title
    title: v.string(),
    // Video description
    description: v.string(),
    // Thumbnail URL (default quality)
    thumbnailUrl: v.string(),
    // ISO 8601 duration string (e.g. "PT4M13S")
    duration: v.string(),
    // Channel ID
    channelId: v.string(),
    // Channel title
    channelTitle: v.string(),
    // ISO 8601 publish date
    publishedAt: v.string(),
    // View count (as string from YouTube API)
    viewCount: v.string(),
    // Like count (as string from YouTube API)
    likeCount: v.string(),
    // When this entry was cached (ms since epoch)
    cachedAt: v.number(),
    // TTL in ms — entry is stale after cachedAt + ttl
    ttl: v.number(),
  })
    .index("by_videoId", ["videoId"])
    .index("by_cachedAt", ["cachedAt"]),

  // Rate limiter state for YouTube API quota management
  rateLimiter: defineTable({
    // Total quota units consumed in the current window
    quotaUsed: v.number(),
    // Maximum quota units per window (default: 10,000/day)
    quotaLimit: v.number(),
    // Start of the current quota window (ms since epoch)
    windowStart: v.number(),
    // Number of active reservations (pending requests)
    reservations: v.number(),
  }),

  // Cache statistics
  cacheStats: defineTable({
    // Total cache hits
    hits: v.number(),
    // Total cache misses
    misses: v.number(),
    // Total requests processed
    totalRequests: v.number(),
  }),

  // Reservation queue — requests waiting for quota
  reservationQueue: defineTable({
    // Unique reservation ID
    reservationId: v.string(),
    // Video IDs requested
    videoIds: v.array(v.string()),
    // Quota cost of this request
    quotaCost: v.number(),
    // When the reservation was created
    createdAt: v.number(),
    // Timeout deadline (ms since epoch)
    deadline: v.number(),
    // Status: "pending" | "fulfilled" | "expired"
    status: v.string(),
  })
    .index("by_reservationId", ["reservationId"])
    .index("by_status", ["status"])
    .index("by_deadline", ["deadline"]),
});
