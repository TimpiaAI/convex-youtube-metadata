import type { api } from "../component/_generated/api.js";

type ComponentApi = typeof api;

// Context types for running component functions from the app
interface RunMutationCtx {
  runMutation: <Args extends Record<string, any>, Returns>(
    ref: any,
    args: Args
  ) => Promise<Returns>;
}

interface RunQueryCtx {
  runQuery: <Args extends Record<string, any>, Returns>(
    ref: any,
    args: Args
  ) => Promise<Returns>;
}

interface RunActionCtx {
  runAction: <Args extends Record<string, any>, Returns>(
    ref: any,
    args: Args
  ) => Promise<Returns>;
}

// ─── Result Types ────────────────────────────────────────────────

export interface VideoMetadata {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: string;
  likeCount: string;
  cachedAt: number;
  ttl: number;
  fresh: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  totalRequests: number;
  hitRate: number;
  quotaUsed: number;
  quotaLimit: number;
  activeReservations: number;
  quotaWindowStart: number;
}

export interface QuotaResult {
  allowed: boolean;
  retryAfterMs?: number;
  quotaUsed: number;
  quotaLimit: number;
}

export interface ReservationResult {
  reservationId: string;
  deadline: number;
  quotaCost: number;
}

// ─── Options ─────────────────────────────────────────────────────

export interface YouTubeMetadataCacheOptions {
  /**
   * YouTube Data API v3 key.
   * Components cannot access environment variables — pass it explicitly.
   */
  apiKey: string;

  /**
   * Default TTL for cached entries in milliseconds.
   * Default: 3,600,000 (1 hour)
   */
  defaultTtlMs?: number;

  /**
   * Maximum quota units per day.
   * Default: 10,000 (YouTube API default)
   */
  quotaLimit?: number;

  /**
   * Reservation timeout in milliseconds.
   * How long to wait for quota before failing.
   * Default: 10,000 (10 seconds)
   */
  reservationTimeoutMs?: number;

  /**
   * Maximum retry attempts on transient failures.
   * Default: 3
   */
  maxRetries?: number;

  /**
   * Base delay for exponential backoff in milliseconds.
   * Default: 1,000 (1 second)
   */
  baseRetryDelayMs?: number;
}

// ─── YouTube API Types ──────────────────────────────────────────

interface YouTubeVideoSnippet {
  title: string;
  description: string;
  thumbnails: {
    default?: { url: string };
    medium?: { url: string };
    high?: { url: string };
  };
  channelId: string;
  channelTitle: string;
  publishedAt: string;
}

interface YouTubeVideoContentDetails {
  duration: string;
}

interface YouTubeVideoStatistics {
  viewCount?: string;
  likeCount?: string;
}

interface YouTubeVideoItem {
  id: string;
  snippet: YouTubeVideoSnippet;
  contentDetails: YouTubeVideoContentDetails;
  statistics: YouTubeVideoStatistics;
}

interface YouTubeApiResponse {
  items: YouTubeVideoItem[];
}

// ─── Main Client Class ──────────────────────────────────────────

/**
 * Client for the YouTube Metadata Cache component.
 *
 * Caches YouTube video metadata with configurable TTL, built-in rate limiting,
 * and a reservation system for quota management.
 *
 * Usage:
 * ```ts
 * const ytCache = new YouTubeMetadataCache(components.youtubeMetadata, {
 *   apiKey: "YOUR_YOUTUBE_API_KEY",
 * });
 * ```
 */
export class YouTubeMetadataCache {
  public component: ComponentApi;
  private apiKey: string;
  private defaultTtlMs: number;
  private quotaLimit: number;
  private reservationTimeoutMs: number;
  private maxRetries: number;
  private baseRetryDelayMs: number;

  constructor(component: ComponentApi, options: YouTubeMetadataCacheOptions) {
    this.component = component;
    this.apiKey = options.apiKey;
    this.defaultTtlMs = options.defaultTtlMs ?? 3_600_000; // 1 hour
    this.quotaLimit = options.quotaLimit ?? 10_000;
    this.reservationTimeoutMs = options.reservationTimeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  }

  // ─── Core API ─────────────────────────────────────────────────

  /**
   * Get metadata for a single video.
   * Returns cached data immediately if fresh; fetches from YouTube API if stale or missing.
   *
   * This method must be called from a Convex action (since it makes HTTP requests).
   */
  async getVideo(
    ctx: RunMutationCtx & RunQueryCtx & RunActionCtx,
    args: { videoId: string; ttl?: number }
  ): Promise<VideoMetadata | null> {
    // Check cache first
    const cached = await ctx.runQuery(
      this.component.public.getCachedVideo,
      { videoId: args.videoId }
    ) as VideoMetadata | null;

    if (cached && cached.fresh) {
      await ctx.runMutation(this.component.public.recordHit, {});
      return cached;
    }

    // Cache miss or stale — fetch from YouTube
    await ctx.runMutation(this.component.public.recordMiss, {});

    // Check quota
    const quota = await ctx.runMutation(
      this.component.public.consumeQuota,
      { units: 1 }
    ) as QuotaResult;

    if (!quota.allowed) {
      // If we have stale data, return it rather than failing
      if (cached) return cached;

      // Try reservation system
      const reservation = await ctx.runMutation(
        this.component.public.createReservation,
        {
          videoIds: [args.videoId],
          timeoutMs: this.reservationTimeoutMs,
        }
      ) as ReservationResult;

      // Poll for fulfillment
      const fulfilled = await this._waitForReservation(ctx, reservation.reservationId);
      if (!fulfilled) {
        return null; // Quota exhausted and timeout expired
      }
    }

    // Fetch from YouTube API
    const videoData = await this._fetchFromYouTube([args.videoId]);
    if (!videoData || videoData.length === 0) return null;

    const video = videoData[0];
    const ttl = args.ttl ?? this.defaultTtlMs;

    // Store in cache
    await ctx.runMutation(this.component.public.storeVideo, {
      ...video,
      ttl,
    });

    return {
      ...video,
      cachedAt: Date.now(),
      ttl,
      fresh: true,
    };
  }

  /**
   * Get metadata for multiple videos in a single batch.
   * Returns cached data immediately for fresh entries; fetches missing/stale from YouTube API.
   *
   * This method must be called from a Convex action (since it makes HTTP requests).
   */
  async getVideos(
    ctx: RunMutationCtx & RunQueryCtx & RunActionCtx,
    args: { videoIds: string[]; ttl?: number }
  ): Promise<(VideoMetadata | null)[]> {
    const ttl = args.ttl ?? this.defaultTtlMs;

    // Check cache for all videos
    const cached = await ctx.runQuery(
      this.component.public.getCachedVideos,
      { videoIds: args.videoIds }
    ) as (VideoMetadata | null)[];

    // Determine which IDs need fetching
    const needFetch: string[] = [];
    const results: (VideoMetadata | null)[] = [...cached];

    for (let i = 0; i < args.videoIds.length; i++) {
      const entry = cached[i];
      if (!entry || !entry.fresh) {
        needFetch.push(args.videoIds[i]);
        // Record stats
        await ctx.runMutation(this.component.public.recordMiss, {});
      } else {
        await ctx.runMutation(this.component.public.recordHit, {});
      }
    }

    if (needFetch.length === 0) return results;

    // Check quota (batch = 1 API call)
    const quota = await ctx.runMutation(
      this.component.public.consumeQuota,
      { units: 1 }
    ) as QuotaResult;

    if (!quota.allowed) {
      // Try reservation
      const reservation = await ctx.runMutation(
        this.component.public.createReservation,
        {
          videoIds: needFetch,
          timeoutMs: this.reservationTimeoutMs,
        }
      ) as ReservationResult;

      const fulfilled = await this._waitForReservation(ctx, reservation.reservationId);
      if (!fulfilled) {
        // Return stale data where available, null otherwise
        return results;
      }
    }

    // Fetch missing videos from YouTube
    const fetched = await this._fetchFromYouTube(needFetch);
    const fetchedMap = new Map(fetched.map((v) => [v.videoId, v]));

    // Store all fetched videos
    if (fetched.length > 0) {
      await ctx.runMutation(this.component.public.storeVideos, {
        videos: fetched,
        ttl,
      });
    }

    // Merge results
    for (let i = 0; i < args.videoIds.length; i++) {
      const videoId = args.videoIds[i];
      const fetchedVideo = fetchedMap.get(videoId);
      if (fetchedVideo) {
        results[i] = {
          ...fetchedVideo,
          cachedAt: Date.now(),
          ttl,
          fresh: true,
        };
      }
    }

    return results;
  }

  /**
   * Get cache statistics: hit rate, quota usage, active reservations.
   */
  async getCacheStats(ctx: RunQueryCtx): Promise<CacheStats> {
    return await ctx.runQuery(
      this.component.public.getCacheStats,
      {}
    ) as CacheStats;
  }

  /**
   * Clear all cached video entries and reset statistics.
   */
  async clearCache(ctx: RunMutationCtx): Promise<number> {
    return await ctx.runMutation(
      this.component.public.clearCache,
      {}
    ) as number;
  }

  /**
   * Set the daily quota limit for the YouTube API rate limiter.
   */
  async setQuotaLimit(
    ctx: RunMutationCtx,
    args: { quotaLimit: number }
  ): Promise<void> {
    await ctx.runMutation(this.component.public.setQuotaLimit, args);
  }

  /**
   * Remove stale cache entries. Call on a schedule for maintenance.
   */
  async cleanupStale(ctx: RunMutationCtx): Promise<number> {
    return await ctx.runMutation(
      this.component.public.cleanupStale,
      {}
    ) as number;
  }

  /**
   * Reset the rate limiter quota window.
   */
  async resetQuota(ctx: RunMutationCtx): Promise<void> {
    await ctx.runMutation(this.component.public.resetQuota, {});
  }

  // ─── Internal Methods ─────────────────────────────────────────

  /**
   * Fetch video metadata from the YouTube Data API v3 with retry logic.
   */
  private async _fetchFromYouTube(
    videoIds: string[]
  ): Promise<
    Array<{
      videoId: string;
      title: string;
      description: string;
      thumbnailUrl: string;
      duration: string;
      channelId: string;
      channelTitle: string;
      publishedAt: string;
      viewCount: string;
      likeCount: string;
    }>
  > {
    const ids = videoIds.join(",");
    const url =
      `https://www.googleapis.com/youtube/v3/videos` +
      `?part=snippet,contentDetails,statistics` +
      `&id=${encodeURIComponent(ids)}` +
      `&key=${encodeURIComponent(this.apiKey)}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        if (!this.apiKey) {
          throw new Error(
            "YouTube API key not configured. Set the YOUTUBE_API_KEY environment variable in your Convex dashboard."
          );
        }

        const response = await fetch(url);

        if (response.status === 400) {
          const errorBody = await response.text();
          throw new Error(
            `YouTube API error: HTTP 400 — check that your YOUTUBE_API_KEY is valid. Details: ${errorBody}`
          );
        }

        if (response.status === 403 || response.status === 429) {
          // Quota exceeded or rate limited — don't retry
          throw new Error(
            `YouTube API quota exceeded (HTTP ${response.status})`
          );
        }

        if (!response.ok) {
          throw new Error(`YouTube API error: HTTP ${response.status}`);
        }

        const data = (await response.json()) as YouTubeApiResponse;

        return (data.items || []).map((item) => ({
          videoId: item.id,
          title: item.snippet.title,
          description: item.snippet.description,
          thumbnailUrl:
            item.snippet.thumbnails.high?.url ??
            item.snippet.thumbnails.medium?.url ??
            item.snippet.thumbnails.default?.url ??
            "",
          duration: item.contentDetails.duration,
          channelId: item.snippet.channelId,
          channelTitle: item.snippet.channelTitle,
          publishedAt: item.snippet.publishedAt,
          viewCount: item.statistics.viewCount ?? "0",
          likeCount: item.statistics.likeCount ?? "0",
        }));
      } catch (error) {
        lastError = error as Error;

        // Don't retry on quota/auth errors
        if (
          lastError.message.includes("quota exceeded") ||
          lastError.message.includes("403")
        ) {
          throw lastError;
        }

        // Exponential backoff for transient failures
        if (attempt < this.maxRetries - 1) {
          const delay = this.baseRetryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error("Failed to fetch from YouTube API");
  }

  /**
   * Wait for a reservation to be fulfilled with polling.
   */
  private async _waitForReservation(
    ctx: RunMutationCtx,
    reservationId: string
  ): Promise<boolean> {
    const pollInterval = 500; // 500ms between polls
    const maxPolls = Math.ceil(this.reservationTimeoutMs / pollInterval);

    for (let i = 0; i < maxPolls; i++) {
      const result = (await ctx.runMutation(
        this.component.public.fulfillReservation,
        { reservationId }
      )) as { fulfilled: boolean; expired: boolean };

      if (result.fulfilled) return true;
      if (result.expired) return false;

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout — cancel reservation
    await ctx.runMutation(this.component.public.cancelReservation, {
      reservationId,
    });
    return false;
  }
}

export default YouTubeMetadataCache;
