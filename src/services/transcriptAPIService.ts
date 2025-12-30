/**
 * TranscriptAPI.com Service
 *
 * This service provides YouTube transcript fetching via TranscriptAPI.com
 * API Documentation: https://transcriptapi.com/docs/api/
 *
 * Features:
 * - Simple GET endpoint with Bearer auth
 * - Returns plain text transcripts (no timestamps)
 * - Rate limiting and circuit breaker support
 * - Credit usage tracking
 */

import { config } from "../config";
import { TranscriptError } from "../errors";
import {
  logger,
  retryWithBackoff,
  EnhancedRateLimiter,
  CircuitBreaker,
  RateLimitMonitor,
  sleep,
} from "../utils";
import axios, { AxiosError } from "axios";

// Response types
interface TranscriptAPIResponse {
  video_id: string;
  language: string;
  transcript: string; // Plain text when format=text
  metadata?: {
    title: string;
    author_name: string;
    author_url: string;
    thumbnail_url: string;
  };
}

interface TranscriptAPIErrorResponse {
  error: string;
  message: string;
  details?: any;
}

export class TranscriptAPIService {
  private readonly baseUrl = "https://transcriptapi.com/api/v2";
  private readonly rateLimiter: EnhancedRateLimiter;
  private readonly circuitBreaker: CircuitBreaker;
  private creditsUsed = 0;
  private creditsRemaining: number | null = null;
  private lastCreditCheck: Date | null = null;

  constructor() {
    // TranscriptAPI rate limiting - use config value
    this.rateLimiter = new EnhancedRateLimiter(config.transcriptapiRateLimit);

    // Circuit breaker for TranscriptAPI
    this.circuitBreaker = new CircuitBreaker(
      config.rateLimiting.circuitBreakerFailureThreshold,
      config.rateLimiting.circuitBreakerResetTimeout
    );
  }

  /**
   * Check if TranscriptAPI is properly configured
   */
  isConfigured(): boolean {
    const apiKey = process.env.TRANSCRIPTAPI_COM_API_KEY;
    return !!apiKey && apiKey.length > 10;
  }

  /**
   * Test TranscriptAPI connection
   */
  async testConnection(): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn(
        "TranscriptAPI is not configured (missing TRANSCRIPTAPI_COM_API_KEY)"
      );
      return false;
    }

    try {
      // Test with a known video that has transcripts
      const testVideoId = "dQw4w9WgXcQ";
      const transcript = await this.getVideoTranscript(testVideoId);

      if (transcript && transcript.length > 0) {
        logger.info("TranscriptAPI connection test successful");
        return true;
      }

      logger.warn("TranscriptAPI connection test returned empty transcript");
      return false;
    } catch (error) {
      logger.error("TranscriptAPI connection test failed", {
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get video transcript from TranscriptAPI.com
   * Uses circuit breaker pattern and retry with backoff for reliability
   * @param videoId YouTube video ID
   * @returns Plain text transcript without timestamps
   */
  async getVideoTranscript(videoId: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new TranscriptError("TranscriptAPI is not configured");
    }

    const startTime = Date.now();

    try {
      // Use circuit breaker's execute() method for proper failure tracking
      return await this.circuitBreaker.execute(async () => {
        // Add retry with backoff for transient failures
        return await retryWithBackoff(
          async () => this.fetchTranscriptFromAPI(videoId),
          config.transcriptapiMaxRetries,
          2000 // 2 second base delay
        );
      });
    } catch (error) {
      const totalTime = Date.now() - startTime;
      const isRateLimitError =
        (error as Error).message.includes("429") ||
        (error as Error).message.includes("Rate limit");

      logger.error(`TranscriptAPI failed for video ${videoId}`, {
        error: (error as Error).message,
        totalTime,
        isRateLimitError,
      });

      // Record metrics
      RateLimitMonitor.recordRequest(
        "transcriptapi",
        false,
        totalTime,
        isRateLimitError
      );

      throw error;
    }
  }

  /**
   * Internal method to fetch transcript from API
   * Separated for use with retryWithBackoff
   */
  private async fetchTranscriptFromAPI(videoId: string): Promise<string> {
    const apiKey = process.env.TRANSCRIPTAPI_COM_API_KEY!;
    const url = `${this.baseUrl}/youtube/transcript`;
    const startTime = Date.now();

    // Wait for rate limiter
    await this.rateLimiter.wait();

    logger.debug(`Fetching transcript from TranscriptAPI for video ${videoId}`);

    try {
      const response = await axios.get<TranscriptAPIResponse>(url, {
        params: {
          video_url: videoId,
          format: "text",
          include_timestamp: false,
          send_metadata: false,
        },
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: config.requestTimeout,
      });

      const responseTime = Date.now() - startTime;

      // Track credit usage from response headers
      this.updateCreditInfo(response.headers);

      const data = response.data;

      if (!data.transcript || data.transcript.trim().length === 0) {
        throw new TranscriptError(
          `Empty transcript returned for video ${videoId}`
        );
      }

      // Record successful metrics
      RateLimitMonitor.recordRequest("transcriptapi", true, responseTime);

      logger.info(`TranscriptAPI transcript fetched for video ${videoId}`, {
        language: data.language,
        length: data.transcript.length,
        responseTime,
        creditsRemaining: this.creditsRemaining,
      });

      return data.transcript;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError<TranscriptAPIErrorResponse>;
        const status = axiosError.response?.status;
        const errorData = axiosError.response?.data;

        // Update credit info even on error (if available)
        if (axiosError.response?.headers) {
          this.updateCreditInfo(axiosError.response.headers);
        }

        // Record metrics for specific error types
        const isRateLimitError = status === 429;
        RateLimitMonitor.recordRequest(
          "transcriptapi",
          false,
          responseTime,
          isRateLimitError
        );

        if (status === 401) {
          throw new TranscriptError(
            "TranscriptAPI: Unauthorized - Invalid API key"
          );
        } else if (status === 402) {
          throw new TranscriptError(
            "TranscriptAPI: Payment Required - Insufficient credits"
          );
        } else if (status === 404) {
          throw new TranscriptError(
            `TranscriptAPI: Video not found or transcript unavailable for ${videoId}`
          );
        } else if (status === 408) {
          throw new TranscriptError("TranscriptAPI: Request timeout");
        } else if (status === 422) {
          throw new TranscriptError(
            `TranscriptAPI: Invalid video URL or ID: ${videoId}`
          );
        } else if (status === 429) {
          // Handle rate limiting - use enhanced rate limiter's 429 handling
          const retryAfter = axiosError.response?.headers["retry-after"];
          logger.warn(
            `TranscriptAPI rate limited, retry after: ${
              retryAfter || "unknown"
            }`
          );
          await this.rateLimiter.handle429Error();
          throw new TranscriptError("TranscriptAPI: Rate limit exceeded");
        } else if (status === 503) {
          throw new TranscriptError("TranscriptAPI: Service unavailable");
        } else {
          throw new TranscriptError(
            `TranscriptAPI error (${status}): ${
              errorData?.message || axiosError.message
            }`
          );
        }
      }

      throw new TranscriptError(
        `TranscriptAPI failed: ${(error as Error).message}`
      );
    }
  }

  /**
   * Update credit information from response headers
   */
  private updateCreditInfo(headers: any): void {
    const creditsUsed = headers["x-credits-used"];
    const creditsRemaining = headers["x-credits-remaining"];

    if (creditsUsed) {
      this.creditsUsed += parseInt(creditsUsed, 10);
    }

    if (creditsRemaining) {
      this.creditsRemaining = parseInt(creditsRemaining, 10);
      this.lastCreditCheck = new Date();
    }
  }

  /**
   * Get credit usage statistics
   */
  getCreditStats(): any {
    return {
      creditsUsed: this.creditsUsed,
      creditsRemaining: this.creditsRemaining,
      lastCheck: this.lastCreditCheck?.toISOString() || null,
    };
  }

  /**
   * Reset credit usage (for testing or manual reset)
   */
  resetCredits(): void {
    this.creditsUsed = 0;
    logger.info("TranscriptAPI credit usage reset");
  }

  /**
   * Get current rate limiting statistics
   */
  getRateLimitStats(): any {
    const cbStatus = this.circuitBreaker.getStatus();
    return {
      service: "transcriptapi",
      configured: this.isConfigured(),
      circuitBreakerState: cbStatus.isOpen ? "open" : "closed",
      circuitBreakerFailures: cbStatus.failureCount,
      credits: this.getCreditStats(),
    };
  }

  /**
   * Reset rate limiting metrics
   */
  resetMetrics(): void {
    // CircuitBreaker doesn't have a reset method, it resets automatically after timeout
    this.creditsUsed = 0;
    logger.info("TranscriptAPI metrics reset");
  }
}

// Export singleton instance
export const transcriptAPIService = new TranscriptAPIService();
