# convex-youtube-metadata

[![npm](https://img.shields.io/npm/v/convex-youtube-metadata)](https://www.npmjs.com/package/convex-youtube-metadata)
[![license](https://img.shields.io/npm/l/convex-youtube-metadata)](https://github.com/TimpiaAI/convex-youtube-metadata/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)

A [Convex](https://convex.dev) component for **YouTube video metadata caching** with built-in rate limiting, TTL management, a reservation system, and batch lookups.

Built for apps that need fast, reliable access to YouTube video data without exceeding API quotas.

> **Convex Components Challenge** -- YouTube Metadata Cache with Rate Limiting

## Features

- **Smart Caching** -- Cache video metadata (title, description, thumbnail, duration, channel info) with configurable TTL
- **Rate Limiting** -- Built-in rate limiter to stay within YouTube API quotas (default: 10,000 units/day)
- **Reservation System** -- Queue requests when at capacity, wait up to configurable timeout (default 10s) before failing
- **Stale-While-Revalidate** -- Return cached data immediately when available, fetch fresh data when stale or missing
- **Batch Lookups** -- Fetch multiple video IDs in a single API call for efficient quota usage
- **Cache Statistics** -- Monitor hit rate, quota usage, and active reservations
- **Retry with Backoff** -- Configurable retry logic with exponential backoff on transient failures
- **Zero Environment Variables** -- YouTube API key passed as configuration (components cannot use env vars)

## Installation

```bash
npm install convex-youtube-metadata
```

## Setup

### 1. Register the component

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import youtubeMetadata from "convex-youtube-metadata/convex.config";

const app = defineApp();
app.use(youtubeMetadata);

export default app;
```

### 2. Initialize the client

```ts
// convex/youtube.ts
import { YouTubeMetadataCache } from "convex-youtube-metadata";
import { components } from "./_generated/api.js";

const ytCache = new YouTubeMetadataCache(components.youtubeMetadata, {
  apiKey: "YOUR_YOUTUBE_DATA_API_V3_KEY",
  defaultTtlMs: 3_600_000, // 1 hour (optional)
  quotaLimit: 10_000,       // daily quota (optional)
  reservationTimeoutMs: 10_000, // 10s wait (optional)
  maxRetries: 3,            // retry attempts (optional)
  baseRetryDelayMs: 1_000,  // backoff base (optional)
});
```

> **Tip:** Store your YouTube API key in the Convex dashboard as an environment variable, then pass it to the constructor:
> ```ts
> const ytCache = new YouTubeMetadataCache(components.youtubeMetadata, {
>   apiKey: process.env.YOUTUBE_API_KEY!,
> });
> ```

## Usage

### Get a single video

```ts
import { action } from "./_generated/server.js";
import { v } from "convex/values";

export const getVideo = action({
  args: { videoId: v.string() },
  handler: async (ctx, args) => {
    const video = await ytCache.getVideo(ctx, {
      videoId: args.videoId,
    });

    if (!video) throw new Error("Video not found");

    return {
      title: video.title,
      channel: video.channelTitle,
      duration: video.duration,
      views: video.viewCount,
    };
  },
});
```

### Batch lookup

```ts
export const getPlaylist = action({
  args: { videoIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    // Single API call for up to 50 videos
    const videos = await ytCache.getVideos(ctx, {
      videoIds: args.videoIds,
      ttl: 2 * 60 * 60 * 1000, // 2 hour TTL
    });

    return videos.filter((v) => v !== null);
  },
});
```

### Check cache stats

```ts
import { query } from "./_generated/server.js";

export const stats = query({
  handler: async (ctx) => {
    const stats = await ytCache.getCacheStats(ctx);

    return {
      hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
      quotaUsed: `${stats.quotaUsed}/${stats.quotaLimit}`,
      activeReservations: stats.activeReservations,
    };
  },
});
```

### Clear cache

```ts
import { mutation } from "./_generated/server.js";

export const resetCache = mutation({
  handler: async (ctx) => {
    const deleted = await ytCache.clearCache(ctx);
    console.log(`Cleared ${deleted} cached videos`);
  },
});
```

### Adjust quota limit

```ts
export const updateQuota = mutation({
  handler: async (ctx) => {
    // If you have a higher quota from Google
    await ytCache.setQuotaLimit(ctx, { quotaLimit: 50_000 });
  },
});
```

### Schedule stale cleanup

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.hourly("cleanup stale cache", { minuteUTC: 0 }, internal.youtube.cleanup);
export default crons;

// convex/youtube.ts
export const cleanup = internalMutation({
  handler: async (ctx) => {
    const deleted = await ytCache.cleanupStale(ctx);
    console.log(`Cleaned up ${deleted} stale entries`);
  },
});
```

## How It Works

1. **Cache Check** -- On every request, the component checks the local Convex database for a cached entry.
2. **Fresh Hit** -- If the entry exists and is within its TTL, it's returned immediately (cache hit).
3. **Stale/Miss** -- If the entry is missing or stale, the component checks the rate limiter.
4. **Quota Available** -- If quota is available, it fetches fresh data from the YouTube API.
5. **Quota Exhausted** -- If quota is exhausted, a reservation is created. The request waits (up to `reservationTimeoutMs`) for quota to free up.
6. **Graceful Degradation** -- If the wait times out, stale data is returned when available. Otherwise, null is returned.
7. **Retry Logic** -- Transient HTTP errors trigger exponential backoff retries (up to `maxRetries` attempts).

## API Reference

### `YouTubeMetadataCache` class

| Method | Context | Description |
|--------|---------|-------------|
| `getVideo(ctx, { videoId, ttl? })` | action | Get metadata for a single video |
| `getVideos(ctx, { videoIds, ttl? })` | action | Batch lookup for multiple videos |
| `getCacheStats(ctx)` | query | Get hit rate, quota usage, reservations |
| `clearCache(ctx)` | mutation | Clear all cached entries and reset stats |
| `setQuotaLimit(ctx, { quotaLimit })` | mutation | Update the daily quota limit |
| `cleanupStale(ctx)` | mutation | Remove entries past their TTL |
| `resetQuota(ctx)` | mutation | Reset quota counter and start fresh window |

### `VideoMetadata` type

| Field | Type | Description |
|-------|------|-------------|
| `videoId` | `string` | YouTube video ID |
| `title` | `string` | Video title |
| `description` | `string` | Video description |
| `thumbnailUrl` | `string` | Highest quality thumbnail URL |
| `duration` | `string` | ISO 8601 duration (e.g. `PT4M13S`) |
| `channelId` | `string` | Channel ID |
| `channelTitle` | `string` | Channel name |
| `publishedAt` | `string` | ISO 8601 publish date |
| `viewCount` | `string` | View count |
| `likeCount` | `string` | Like count |
| `cachedAt` | `number` | When this entry was cached (ms since epoch) |
| `ttl` | `number` | TTL in milliseconds |
| `fresh` | `boolean` | Whether the entry is within its TTL |

### Constructor options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | YouTube Data API v3 key |
| `defaultTtlMs` | `number` | `3,600,000` | Default cache TTL (1 hour) |
| `quotaLimit` | `number` | `10,000` | Max quota units per day |
| `reservationTimeoutMs` | `number` | `10,000` | Max wait time for quota (10s) |
| `maxRetries` | `number` | `3` | Retry attempts on transient failures |
| `baseRetryDelayMs` | `number` | `1,000` | Base delay for exponential backoff |

## Live Demo

Check out the live demo at [youtube-metadata-demo.vercel.app](https://youtube-metadata-demo.vercel.app).

## Author

Built and maintained by [TimpiaAI](https://github.com/TimpiaAI).

## License

[MIT](https://github.com/TimpiaAI/convex-youtube-metadata/blob/main/LICENSE)
