import { google, youtube_v3 } from "googleapis";
import { config } from "./config";
import { YouTubeVideo, YouTubeError } from "./types";
import { YouTubeError as YouTubeServiceError, TranscriptError } from "./errors";
import {
  logger,
  retryWithBackoff,
  RateLimiter,
  isValidYouTubeVideoId,
  isValidYouTubeChannelId,
  extractVideoIdFromUrl,
  parseYouTubeDuration,
} from "./utils";
import { rapidapiService } from "./rapidapi";
import { supadataService } from "./supadataService";
import { transcriptAPIService } from "./services/transcriptAPIService";

export class YouTubeService {
  private youtube: youtube_v3.Youtube;
  private rateLimiter: RateLimiter;

  constructor() {
    this.youtube = google.youtube({
      version: "v3",
      auth: config.youtubeApiKey,
    });

    // Rate limit to respect YouTube API quota (10000 units per day)
    this.rateLimiter = new RateLimiter(2); // 2 requests per second
  }

  // Test YouTube API connection
  async testConnection(): Promise<boolean> {
    try {
      await this.rateLimiter.wait();
      const response = await this.youtube.channels.list({
        part: ["id"],
        maxResults: 1,
        id: ["UCBR8-60-B28hp2BmDPdntcQ"], // YouTube's official channel
      });

      if (response.status !== 200) {
        throw new YouTubeServiceError(
          `YouTube API test failed with status ${response.status}`,
          { code: response.status }
        );
      }

      logger.info("YouTube API connection successful");
      return true;
    } catch (error) {
      logger.error("YouTube API connection test failed", { error });
      throw error;
    }
  }

  // Get channel details by ID
  async getChannelDetails(channelId: string): Promise<{
    id: string;
    title: string;
    description?: string;
    publishedAt: string;
    subscriberCount?: number;
    videoCount?: number;
    raw?: any;
  }> {
    if (!isValidYouTubeChannelId(channelId)) {
      throw new YouTubeServiceError(`Invalid channel ID format: ${channelId}`);
    }

    try {
      await this.rateLimiter.wait();
      const response = await this.youtube.channels.list({
        part: ["snippet", "statistics"],
        id: [channelId],
      });

      if (response.status !== 200) {
        throw new YouTubeServiceError(
          `Failed to fetch channel details: HTTP ${response.status}`,
          { code: response.status }
        );
      }

      const channels = response.data.items;
      if (!channels || channels.length === 0) {
        throw new YouTubeServiceError(`Channel not found: ${channelId}`);
      }

      const channel = channels[0];
      const snippet = channel.snippet;
      const statistics = channel.statistics;

      return {
        id: channel.id!,
        title: snippet?.title || "Unknown Channel",
        description: snippet?.description,
        publishedAt: snippet?.publishedAt || new Date().toISOString(),
        subscriberCount: statistics?.subscriberCount
          ? parseInt(statistics.subscriberCount)
          : undefined,
        videoCount: statistics?.videoCount
          ? parseInt(statistics.videoCount)
          : undefined,
        // Return full raw info for storage
        raw: {
          snippet,
          statistics,
        },
      };
    } catch (error) {
      if (error instanceof YouTubeServiceError) {
        throw error;
      }
      logger.error(`Error fetching channel details for ${channelId}`, {
        error,
      });
      throw new YouTubeServiceError(
        `Failed to fetch channel details: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }

  // Get videos from channel since specific date (optionally until another date)
  // OPTIMIZED: Uses playlistItems.list (1 unit) instead of search.list (100 units)
  // Falls back to search.list if playlistItems fails
  async getChannelVideos(
    channelId: string,
    publishedAfter: Date,
    publishedBefore?: Date
  ): Promise<YouTubeVideo[]> {
    if (!isValidYouTubeChannelId(channelId)) {
      throw new YouTubeServiceError(`Invalid channel ID format: ${channelId}`);
    }

    try {
      // Try optimized playlistItems.list first (1 unit per call)
      const videos = await this.getChannelVideosViaPlaylist(
        channelId,
        publishedAfter,
        publishedBefore
      );
      return videos;
    } catch (playlistError) {
      // Log the error and fall back to search.list
      logger.warn(
        `⚠️ playlistItems.list failed for channel ${channelId}, falling back to search.list`,
        { error: (playlistError as Error).message }
      );
      return this.getChannelVideosViaSearch(
        channelId,
        publishedAfter,
        publishedBefore
      );
    }
  }

  // OPTIMIZED: Get videos using playlistItems.list (1 unit per call)
  // Converts channel ID to uploads playlist ID and fetches with early stopping
  private async getChannelVideosViaPlaylist(
    channelId: string,
    publishedAfter: Date,
    publishedBefore?: Date
  ): Promise<YouTubeVideo[]> {
    // Convert channel ID (UC...) to uploads playlist ID (UU...)
    const uploadsPlaylistId = this.getUploadsPlaylistId(channelId);
    const videos: YouTubeVideo[] = [];
    let nextPageToken: string | undefined = undefined;
    let apiCalls = 0;

    logger.info(
      `📋 [OPTIMIZED] Fetching videos via playlistItems.list for channel ${channelId}`
    );

    do {
      apiCalls++;
      await this.rateLimiter.wait();

      const response = await this.youtube.playlistItems.list({
        part: ["snippet", "contentDetails"],
        playlistId: uploadsPlaylistId,
        maxResults: 50, // Maximum allowed
        pageToken: nextPageToken,
      });

      if (response.status !== 200) {
        throw new YouTubeServiceError(
          `Failed to fetch playlist items: HTTP ${response.status}`,
          { code: response.status }
        );
      }

      const items = response.data.items;
      if (!items || items.length === 0) break;

      // Process items and filter by date
      const videoIds: string[] = [];
      let stoppedEarly = false;

      for (const item of items) {
        const contentDetails = item.contentDetails;
        const snippet = item.snippet;

        // Get the video's publish date
        const publishedAt =
          contentDetails?.videoPublishedAt || snippet?.publishedAt;
        if (!publishedAt) continue;

        const videoDate = new Date(publishedAt);

        // Check if video is older than our cutoff - stop early!
        if (videoDate < publishedAfter) {
          logger.debug(
            `⏹️ Hit video older than cutoff (${publishedAt}), stopping pagination`
          );
          stoppedEarly = true;
          break;
        }

        // Check if video is newer than publishedBefore (if specified)
        if (publishedBefore && videoDate > publishedBefore) {
          continue; // Skip this video but don't stop
        }

        const videoId = contentDetails?.videoId;
        if (videoId) {
          videoIds.push(videoId);
        }
      }

      // Get detailed info for matching videos
      if (videoIds.length > 0) {
        const detailedVideos = await this.getVideoDetails(videoIds);
        videos.push(...detailedVideos);
      }

      // If we hit older videos, no need to fetch more pages
      if (stoppedEarly) {
        logger.info(
          `✅ [OPTIMIZED] Stopped early after ${apiCalls} API call(s), found ${videos.length} videos`
        );
        break;
      }

      nextPageToken = response.data.nextPageToken || undefined;

      // Safety limit: Don't fetch more than 10 pages (500 videos)
      if (apiCalls >= 10) {
        logger.warn(`⚠️ Reached max pages (10) for channel ${channelId}`);
        break;
      }
    } while (nextPageToken);

    logger.info(
      `📋 [OPTIMIZED] Fetched ${videos.length} videos for channel ${channelId} using ${apiCalls} API call(s) (${apiCalls} units)`
    );
    return videos;
  }

  // Convert channel ID to uploads playlist ID
  // YouTube channel IDs start with "UC", uploads playlist IDs start with "UU"
  private getUploadsPlaylistId(channelId: string): string {
    if (channelId.startsWith("UC")) {
      return "UU" + channelId.slice(2);
    }
    throw new YouTubeServiceError(
      `Invalid channel ID format for playlist conversion: ${channelId}`
    );
  }

  // LEGACY: Get videos using search.list (100 units per call)
  // Kept as fallback in case playlistItems fails
  private async getChannelVideosViaSearch(
    channelId: string,
    publishedAfter: Date,
    publishedBefore?: Date
  ): Promise<YouTubeVideo[]> {
    try {
      const videos: YouTubeVideo[] = [];
      let nextPageToken: string | undefined = undefined;
      const publishedAfterISO = publishedAfter.toISOString();
      const publishedBeforeISO = publishedBefore?.toISOString();

      logger.info(
        `🔍 [LEGACY] Fetching videos via search.list for channel ${channelId} (100 units/call)`
      );

      do {
        await this.rateLimiter.wait();
        const response = await this.youtube.search.list({
          part: ["snippet"],
          channelId: channelId,
          type: ["video"],
          publishedAfter: publishedAfterISO,
          ...(publishedBeforeISO && { publishedBefore: publishedBeforeISO }),
          maxResults: config.youtubeMaxResults,
          order: "date",
          pageToken: nextPageToken,
        });

        if (response.status !== 200) {
          throw new YouTubeServiceError(
            `Failed to fetch channel videos: HTTP ${response.status}`,
            { code: response.status }
          );
        }

        const items = response.data.items;
        if (!items) break;

        // Get detailed video information for each video
        const videoIds = items
          .map((item) => item.id?.videoId)
          .filter(Boolean) as string[];
        if (videoIds.length > 0) {
          const detailedVideos = await this.getVideoDetails(videoIds);
          videos.push(...detailedVideos);
        }

        nextPageToken = response.data.nextPageToken || undefined;

        // Add small delay to avoid rate limiting
        if (nextPageToken) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } while (nextPageToken);

      logger.info(
        `🔍 [LEGACY] Fetched ${videos.length} videos for channel ${channelId} since ${publishedAfterISO}`
      );
      return videos;
    } catch (error) {
      if (error instanceof YouTubeServiceError) {
        throw error;
      }
      logger.error(`Error fetching videos for channel ${channelId}`, { error });
      throw new YouTubeServiceError(
        `Failed to fetch channel videos: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }

  // Get detailed video information for multiple videos
  private async getVideoDetails(videoIds: string[]): Promise<YouTubeVideo[]> {
    try {
      await this.rateLimiter.wait();
      const response = await this.youtube.videos.list({
        part: ["snippet", "contentDetails"],
        id: videoIds,
      });

      if (response.status !== 200) {
        throw new YouTubeServiceError(
          `Failed to fetch video details: HTTP ${response.status}`,
          { code: response.status }
        );
      }

      const items = response.data.items;
      if (!items) return [];

      return items.map((item) => {
        const snippet = item.snippet;
        const contentDetails = item.contentDetails;

        return {
          videoId: item.id!,
          title: snippet?.title || "Untitled Video",
          publishedAt: snippet?.publishedAt || new Date().toISOString(),
          channelId: snippet?.channelId || "",
          channelTitle: snippet?.channelTitle || "Unknown Channel",
          description: snippet?.description,
          duration: contentDetails?.duration,
          defaultLanguage: snippet?.defaultLanguage,
          defaultAudioLanguage: snippet?.defaultAudioLanguage,
        };
      });
    } catch (error) {
      logger.error("Error fetching video details", { error, videoIds });
      throw new YouTubeServiceError(
        `Failed to fetch video details: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }

  // Get transcript for a video using 3-tier fallback system
  // Returns a structured result so callers can handle 'no transcript' gracefully
  async getVideoTranscript(
    videoId: string,
    videoLanguage?: string
  ): Promise<{ transcript: string | null; error?: string }> {
    if (!isValidYouTubeVideoId(videoId)) {
      return { transcript: null, error: `invalid_video_id:${videoId}` };
    }

    try {
      // ========== TIER 1: RAPIDAPI (Primary) ==========
      if (rapidapiService.isConfigured()) {
        try {
          logger.info(
            `🎯 [TIER 1] Fetching transcript from RapidAPI for video ${videoId}`
          );
          const startTime = Date.now();

          const transcript = await rapidapiService.getVideoTranscript(videoId);

          if (transcript && transcript.trim().length > 0) {
            const duration = Date.now() - startTime;
            logger.info(
              `✅ [TIER 1 SUCCESS] RapidAPI transcript for video ${videoId} (${transcript.length} characters, ${duration}ms)`
            );
            return { transcript };
          }
        } catch (error) {
          const isRateLimitError =
            (error as Error).message.includes("429") ||
            (error as Error).message.includes("rate limit");
          const errorType = isRateLimitError ? "rate_limited" : "failed";

          logger.warn(
            `❌ [TIER 1 ${errorType.toUpperCase()}] RapidAPI transcript failed for video ${videoId}, trying Tier 2`,
            {
              error: (error as Error).message,
              service: "rapidapi",
            }
          );
        }
      } else {
        logger.debug(
          `⏭️ [TIER 1 SKIPPED] RapidAPI not configured for video ${videoId}`
        );
      }

      // ========== TIER 2: SUPADATA DIRECT (Secondary) ==========
      if (supadataService.isConfigured()) {
        try {
          logger.info(
            `🎯 [TIER 2] Fetching transcript from Supadata Direct for video ${videoId}`
          );
          const startTime = Date.now();

          const transcript = await supadataService.getVideoTranscript(videoId);

          if (transcript && transcript.trim().length > 0) {
            const duration = Date.now() - startTime;
            logger.info(
              `✅ [TIER 2 SUCCESS] Supadata Direct transcript for video ${videoId} (${transcript.length} characters, ${duration}ms)`
            );
            return { transcript };
          }
        } catch (error) {
          const isCreditError =
            (error as Error).message.includes("insufficient") ||
            (error as Error).message.includes("credit");

          if (isCreditError) {
            logger.error(
              `💳 [TIER 2 CREDITS EXHAUSTED] Supadata Direct credits exhausted for video ${videoId}`,
              {
                error: (error as Error).message,
                service: "supadata-direct",
              }
            );
            // Don't return early - try Tier 3
          }

          logger.warn(
            `❌ [TIER 2 FAILED] Supadata Direct transcript failed for video ${videoId}`,
            {
              error: (error as Error).message,
              service: "supadata-direct",
            }
          );
        }
      } else {
        logger.debug(
          `⏭️ [TIER 2 SKIPPED] Supadata Direct not configured for video ${videoId}`
        );
      }

      // ========== TIER 3: TRANSCRIPTAPI.COM (Tertiary) ==========
      if (transcriptAPIService.isConfigured()) {
        try {
          logger.info(
            `🎯 [TIER 3] Fetching transcript from TranscriptAPI.com for video ${videoId}`
          );
          const startTime = Date.now();

          const transcript = await transcriptAPIService.getVideoTranscript(
            videoId
          );

          if (transcript && transcript.trim().length > 0) {
            const duration = Date.now() - startTime;
            logger.info(
              `✅ [TIER 3 SUCCESS] TranscriptAPI.com transcript for video ${videoId} (${transcript.length} characters, ${duration}ms)`
            );
            return { transcript };
          }
        } catch (error) {
          const isCreditError =
            (error as Error).message.includes("insufficient") ||
            (error as Error).message.includes("credit") ||
            (error as Error).message.includes("Payment Required");

          if (isCreditError) {
            logger.error(
              `💳 [TIER 3 CREDITS EXHAUSTED] TranscriptAPI.com credits exhausted for video ${videoId}`,
              {
                error: (error as Error).message,
                service: "transcriptapi",
              }
            );
            // Don't return early - fall through to ALL TIERS FAILED
          } else {
            logger.warn(
              `❌ [TIER 3 FAILED] TranscriptAPI.com transcript failed for video ${videoId}`,
              {
                error: (error as Error).message,
                service: "transcriptapi",
              }
            );
          }
        }
      } else {
        logger.warn(
          `⚠️ [TIER 3 NOT AVAILABLE] TranscriptAPI.com not configured (missing TRANSCRIPTAPI_COM_API_KEY) for video ${videoId}`
        );
      }

      // ========== ALL TIERS FAILED ==========
      logger.error(
        `💥 [ALL TIERS FAILED] No transcript available for video ${videoId} from any service`
      );
      return { transcript: null, error: "no_transcript_available" };
    } catch (error) {
      const msg = (error as Error).message || String(error);
      logger.error(
        `💥 [SYSTEM ERROR] All transcript APIs failed for video ${videoId}`,
        {
          error: msg,
          videoId,
        }
      );
      return { transcript: null, error: `transcript_error:${msg}` };
    }
  }

  // Extract language from video metadata
  extractVideoLanguage(video: YouTubeVideo): string | undefined {
    // Try to extract language from video metadata
    // This would need to be implemented when we fetch video details
    // For now, we'll return undefined and handle it in the calling code
    return undefined;
  }

  // Safely attempt to extract a transcript-like block from a description
  // IMPORTANT: by design this MUST NOT synthesize a transcript from metadata.
  // We return null here to explicitly avoid generating transcripts from title/description.
  private extractTranscriptFromDescription(
    description?: string
  ): string | null {
    // Do not synthesize — always return null so calling code must rely on real captions
    return null;
  }

  // Get video metadata by ID
  async getVideoMetadata(videoId: string): Promise<YouTubeVideo | null> {
    if (!isValidYouTubeVideoId(videoId)) {
      throw new YouTubeServiceError(`Invalid video ID format: ${videoId}`);
    }

    try {
      const videos = await this.getVideoDetails([videoId]);
      return videos.length > 0 ? videos[0] : null;
    } catch (error) {
      logger.error(`Error fetching metadata for video ${videoId}`, { error });
      throw new YouTubeServiceError(
        `Failed to fetch video metadata: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }

  // Search for videos by query (useful for finding finfluencer content)
  async searchVideos(
    query: string,
    maxResults: number = 25,
    publishedAfter?: Date
  ): Promise<YouTubeVideo[]> {
    try {
      const videos: YouTubeVideo[] = [];
      let nextPageToken: string | undefined = undefined;

      do {
        await this.rateLimiter.wait();
        const searchParams: any = {
          part: ["snippet"],
          type: ["video"],
          q: query,
          maxResults: Math.min(maxResults, 50),
          order: "relevance",
          pageToken: nextPageToken,
        };

        if (publishedAfter) {
          searchParams.publishedAfter = publishedAfter.toISOString();
        }

        const response = await this.youtube.search.list(searchParams);

        if (response.status !== 200) {
          throw new YouTubeServiceError(
            `Failed to search videos: HTTP ${response.status}`,
            { code: response.status }
          );
        }

        const items = response.data.items;
        if (!items) break;

        // Get detailed video information
        const videoIds = items
          .map((item) => item.id?.videoId)
          .filter(Boolean) as string[];
        if (videoIds.length > 0) {
          const detailedVideos = await this.getVideoDetails(videoIds);
          videos.push(...detailedVideos);
        }

        nextPageToken = response.data.nextPageToken || undefined;
        if (nextPageToken && videos.length >= maxResults) break;
      } while (nextPageToken && videos.length < maxResults);

      logger.info(`Found ${videos.length} videos for query: "${query}"`);
      return videos.slice(0, maxResults);
    } catch (error) {
      logger.error(`Error searching videos for query: "${query}"`, { error });
      throw new YouTubeServiceError(
        `Failed to search videos: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }

  // Extract video ID from various URL formats
  static extractVideoId(url: string): string | null {
    return extractVideoIdFromUrl(url);
  }

  // Check if video is live or upcoming (skip these for transcript processing)
  static isLiveOrUpcoming(video: YouTubeVideo): boolean {
    const title = video.title.toLowerCase();
    const description = (video.description || "").toLowerCase();

    const liveKeywords = [
      "live",
      "premiere",
      "upcoming",
      "stream",
      "broadcast",
    ];

    return liveKeywords.some(
      (keyword) => title.includes(keyword) || description.includes(keyword)
    );
  }

  // Filter videos by duration (skip very short or very long videos)
  static filterByDuration(
    videos: YouTubeVideo[],
    minMinutes: number = 1,
    maxMinutes: number = 180
  ): YouTubeVideo[] {
    return videos.filter((video) => {
      if (!video.duration) return true; // Include if duration unknown

      const durationSeconds = parseYouTubeDuration(video.duration);
      const durationMinutes = durationSeconds / 60;

      return durationMinutes >= minMinutes && durationMinutes <= maxMinutes;
    });
  }

  // Get API quota usage estimate
  getQuotaUsage(): {
    daily: number;
    percentage: number;
    remaining: number;
  } {
    // Rough estimation based on typical usage
    const dailyQuota = config.youtubeApiQuota;
    const estimatedUsage = dailyQuota * 0.1; // Assume 10% usage
    const percentage = (estimatedUsage / dailyQuota) * 100;
    const remaining = dailyQuota - estimatedUsage;

    return {
      daily: estimatedUsage,
      percentage: Math.round(percentage * 100) / 100,
      remaining,
    };
  }

  // Get combined API statistics for all three services
  getApiStats(): any {
    return {
      rapidapi: rapidapiService.getRateLimitStats(),
      supadata: supadataService.getRateLimitStats(),
      supadataCredits: supadataService.getCreditStats(),
      transcriptapi: transcriptAPIService.getRateLimitStats(),
    };
  }
}

// Export singleton instance
export const youtubeService = new YouTubeService();
