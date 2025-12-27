import { supabaseService } from "./supabase";
import { youtubeService } from "./youtube";
import { globalAIAnalyzer } from "./enhancedAnalyzer";
import {
  logger,
  retryWithBackoff,
  isValidYouTubeVideoId,
  EnhancedRateLimiter,
  CircuitBreaker,
  RateLimitMonitor,
  sleep,
  detectLanguage,
} from "./utils";
import { FinfluencerPrediction } from "./types";

export interface RetryRecord {
  id: string;
  video_id: string;
  channel_id: string;
  channel_name?: string;
  video_title: string;
  retry_count: number;
  last_retry_at: string | null;
  retry_reason: string | null;
  default_language?: string;
  post_date: string;
  raw_transcript?: string | null; // OPTIMIZATION: Include saved transcript
}

export interface RetryResult {
  success: boolean;
  transcriptFound: boolean;
  transcriptSource: "saved" | "api" | "none";
  predictionsFound: number;
  error?: string;
  isOutOfSubject?: boolean;
}

export class RetryService {
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly BATCH_SIZE = 3; // Reduced from 5 to 3 for better rate limiting
  private readonly DELAY_BETWEEN_BATCHES = 15000; // Increased to 15s
  private readonly SEQUENTIAL_DELAY = 5000; // 5 seconds between individual records
  private readonly MAX_429_RETRIES = 3;

  // Enhanced rate limiting infrastructure
  private readonly rateLimiter: EnhancedRateLimiter;
  private readonly circuitBreaker: CircuitBreaker;

  constructor() {
    // More conservative rate limiting for retry service
    this.rateLimiter = new EnhancedRateLimiter(0.2); // 1 request per 5 seconds
    // Circuit breaker with threshold for failures
    this.circuitBreaker = new CircuitBreaker(3, 120000); // 3 failures, 2 minute reset
  }

  // Main method to process all failed predictions
  async processFailedPredictions(): Promise<void> {
    try {
      logger.info(
        "🔄 Starting retry process for failed predictions with transcript reuse optimization"
      );

      // Get records that need retry (newer first, excluding out-of-subject videos)
      const recordsToRetry = await this.getRecordsNeedingRetry();

      if (recordsToRetry.length === 0) {
        logger.info("✅ No records found that need retry");
        return;
      }

      logger.info(`📋 Found ${recordsToRetry.length} records to retry`);
      logger.info(
        `⚙️ Batch size: ${this.BATCH_SIZE}, Delay between batches: ${
          this.DELAY_BETWEEN_BATCHES / 1000
        }s`
      );

      // Process in smaller batches with enhanced rate limiting
      for (let i = 0; i < recordsToRetry.length; i += this.BATCH_SIZE) {
        const batch = recordsToRetry.slice(i, i + this.BATCH_SIZE);
        await this.processBatchWithRateLimit(batch);

        // Enhanced delay between batches with jitter
        if (i + this.BATCH_SIZE < recordsToRetry.length) {
          const jitter = Math.random() * 3000; // Add up to 3s jitter
          const finalDelay = this.DELAY_BETWEEN_BATCHES + jitter;

          logger.debug(
            `⏳ Waiting ${(finalDelay / 1000).toFixed(1)}s before next batch...`
          );
          await new Promise((resolve) => setTimeout(resolve, finalDelay));
        }
      }

      // Log final statistics
      const stats = RateLimitMonitor.getStats("retry-service");
      logger.info("✅ Retry process completed", {
        totalRecordsProcessed: recordsToRetry.length,
        rateLimitStats: stats,
      });
    } catch (error) {
      logger.error("❌ Retry process failed", { error });
      throw error;
    }
  }

  // Get records that need retry (newer first, with subject_outcome='pending')
  private async getRecordsNeedingRetry(): Promise<RetryRecord[]> {
    try {
      let query = supabaseService
        .getClient()
        .from("finfluencer_predictions")
        .select(
          `
          id,
          video_id,
          channel_id,
          video_title,
          retry_count,
          last_retry_at,
          retry_reason,
          post_date,
          subject_outcome,
          raw_transcript,
          transcript_summary
        `
        )
        // FIXED: Use subject_outcome='pending' instead of predictions='[]' to avoid JSONB string comparison bug
        .eq("subject_outcome", "pending")
        // Select records with retry_count < MAX (0, 1, 2 are eligible for retry)
        .lt("retry_count", this.MAX_RETRY_ATTEMPTS);

      // OPTIMIZATION: Only retry videos from currently active channels
      // This prevents wasting resources on channels we no longer track
      try {
        const activeChannels = await supabaseService.getActiveChannels();
        const activeChannelIds = activeChannels.map((c) => c.channel_id);

        if (activeChannelIds.length > 0) {
          query = query.in("channel_id", activeChannelIds);
        }
      } catch (channelError) {
        logger.warn(
          "Failed to filter by active channels, proceeding with all channels",
          { error: channelError }
        );
      }

      const { data, error } = await query.order("post_date", {
        ascending: false,
      }); // Newer first

      if (error) {
        throw new Error(`Failed to fetch retry candidates: ${error.message}`);
      }

      return (
        data?.map((record) => ({
          id: record.id,
          video_id: record.video_id,
          channel_id: record.channel_id,
          video_title: record.video_title,
          retry_count: record.retry_count || 0,
          last_retry_at: record.last_retry_at,
          retry_reason: record.retry_reason,
          post_date: record.post_date,
          raw_transcript: record.raw_transcript, // OPTIMIZATION: Use saved transcript if available
        })) || []
      );
    } catch (error) {
      logger.error("Error fetching records for retry", { error });
      throw error;
    }
  }

  // Process a batch with enhanced rate limiting and circuit breaker
  private async processBatchWithRateLimit(
    records: RetryRecord[]
  ): Promise<void> {
    logger.info(
      `🔄 Processing batch of ${records.length} records with rate limiting`
    );

    // Use circuit breaker to protect against repeated failures
    await this.circuitBreaker.execute(async () => {
      // Process records sequentially within batch to reduce load
      const results: RetryResult[] = [];

      for (let i = 0; i < records.length; i++) {
        const record = records[i];

        try {
          logger.debug(
            `Processing record ${i + 1}/${records.length}: ${record.video_id}`
          );

          // Apply rate limiting before each record
          await this.rateLimiter.wait();

          const result = await this.processSingleRecordWith429Handling(record);
          results.push(result);

          // Add small delay between individual records for better rate limiting
          if (i < records.length - 1) {
            await sleep(this.SEQUENTIAL_DELAY);
          }
        } catch (error) {
          logger.error(`Failed to process record ${record.video_id}`, {
            error,
          });
          results.push({
            success: false,
            transcriptFound: false,
            transcriptSource: "none",
            predictionsFound: 0,
            error: (error as Error).message,
          });
        }
      }

      // Log batch results with rate limit statistics
      const successful = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      const rateLimitErrors = results.filter(
        (r) => r.error?.includes("429") || r.error?.includes("rate limit")
      ).length;
      const outOfSubject = results.filter((r) => r.isOutOfSubject).length;
      const savedTranscriptsUsed = results.filter(
        (r) => r.transcriptSource === "saved"
      ).length;
      const apiTranscriptsUsed = results.filter(
        (r) => r.transcriptSource === "api"
      ).length;

      logger.info(
        `📊 Batch completed: ${successful} successful, ${failed} failed, ${rateLimitErrors} rate-limited, ${outOfSubject} out-of-subject`
      );
      logger.info(
        `💾 Transcript optimization: ${savedTranscriptsUsed} used saved transcripts, ${apiTranscriptsUsed} fetched new transcripts`
      );

      // Record batch statistics
      RateLimitMonitor.recordRequest(
        "retry-batch",
        successful > 0,
        Date.now(),
        rateLimitErrors > 0
      );

      if (rateLimitErrors > 0) {
        logger.warn(
          `⚠️ ${rateLimitErrors} rate limit errors in batch - consider reducing batch size`
        );
      }
    });
  }

  // Process a single record with 429-specific error handling
  private async processSingleRecordWith429Handling(
    record: RetryRecord
  ): Promise<RetryResult> {
    const retryNumber = record.retry_count + 1;
    let attempt = 0;

    while (attempt <= this.MAX_429_RETRIES) {
      try {
        return await this.processSingleRecord(record);
      } catch (error) {
        const errorMessage = (error as Error).message;
        const isRateLimitError =
          errorMessage.includes("429") ||
          errorMessage.includes("rate limit") ||
          errorMessage.includes("too many requests");

        if (isRateLimitError && attempt < this.MAX_429_RETRIES) {
          attempt++;
          logger.warn(
            `⚠️ Rate limit hit for ${record.video_id}, retrying with backoff (attempt ${attempt}/${this.MAX_429_RETRIES})`
          );
          await this.rateLimiter.handle429Error(attempt);
          continue;
        }

        // Non-rate-limit error or max retries reached
        await this.updateRetryStatus(record.id, retryNumber, errorMessage);
        logger.error(`❌ Retry failed for video ${record.video_id}`, {
          error,
          attempt: attempt + 1,
          isRateLimitError,
        });

        return {
          success: false,
          transcriptFound: false,
          transcriptSource: "none",
          predictionsFound: 0,
          error: errorMessage,
        };
      }
    }

    // Should not reach here, but just in case
    return {
      success: false,
      transcriptFound: false,
      transcriptSource: "none",
      predictionsFound: 0,
      error: "Max 429 retries exceeded",
    };
  }

  // OPTIMIZED: Process a single record for retry using saved transcript first
  private async processSingleRecord(record: RetryRecord): Promise<RetryResult> {
    const retryNumber = record.retry_count; // Current retry count (0, 1, 2)
    const nextRetryCount = retryNumber + 1; // Next value to store (1, 2, 3)
    const startTime = Date.now();
    let transcriptSource: "saved" | "api" | "none" = "none";

    try {
      logger.info(
        `🔄 Retrying record ${record.video_id} (attempt ${retryNumber + 1}/${
          this.MAX_RETRY_ATTEMPTS
        })`
      );

      // OPTIMIZATION: Check if we have a saved transcript first
      let transcriptText: string | null = null;

      if (record.raw_transcript && record.raw_transcript.trim().length >= 50) {
        // Use saved transcript - no API calls needed!
        transcriptText = record.raw_transcript;
        transcriptSource = "saved";
        logger.info(
          `💾 Using saved transcript for video ${record.video_id} (${transcriptText.length} characters)`
        );
      } else {
        // No saved transcript or it's too short, fetch from API
        logger.info(
          `🔍 No saved transcript found, fetching from API for video ${record.video_id}`
        );

        // Apply rate limiting before API calls
        await this.rateLimiter.wait();

        const transcriptResult = await youtubeService.getVideoTranscript(
          record.video_id,
          record.default_language
        );

        if (!transcriptResult || !transcriptResult.transcript) {
          const error = transcriptResult?.error || "No transcript available";
          await this.updateRetryStatus(record.id, retryNumber, error);
          logger.warn(`⚠️ ${error} for video ${record.video_id}`);
          return {
            success: false,
            transcriptFound: false,
            transcriptSource: "none",
            predictionsFound: 0,
            error,
          };
        }

        // Normalize transcript to string
        transcriptText =
          typeof transcriptResult === "string"
            ? transcriptResult
            : transcriptResult?.transcript ?? "";

        if (!transcriptText || transcriptText.trim().length < 50) {
          const error = "Transcript too short or empty";
          await this.updateRetryStatus(record.id, retryNumber, error);
          logger.warn(`⚠️ ${error} for video ${record.video_id}`);
          return {
            success: false,
            transcriptFound: false,
            transcriptSource: "none",
            predictionsFound: 0,
            error,
          };
        }

        transcriptSource = "api";
        logger.info(
          `🌐 Fetched transcript from API for video ${record.video_id} (${transcriptText.length} characters)`
        );
      }

      // Now we have a valid transcript, proceed with analysis
      logger.info(
        `📝 Processing transcript for video ${record.video_id} (source: ${transcriptSource})`
      );

      // Global analysis with language-agnostic approach
      const analysis = await globalAIAnalyzer.analyzeTranscript(
        transcriptText,
        {
          videoId: record.video_id,
          title: record.video_title,
          channelId: record.channel_id,
          channelName: "", // We don't have this data here, but analyzer should handle it
          publishedAt: record.post_date,
          defaultLanguage: record.default_language,
        }
      );

      // Enhanced validation for out-of-subject detection
      const validationResult = this.enhancedOutOfSubjectValidation(
        analysis,
        transcriptText
      );

      if (validationResult.isOutOfSubject) {
        // Mark as out of subject and never try again
        logger.info(
          `📋 Enhanced analysis determined video ${record.video_id} is out of subject: ${validationResult.reason}`
        );
        await supabaseService.markVideoAsOutOfSubject(
          record.id,
          transcriptText
        );

        return {
          success: true, // Mark as successful to stop retrying
          transcriptFound: true,
          transcriptSource,
          predictionsFound: 0,
          isOutOfSubject: true,
        };
      }

      // Check if we got meaningful predictions
      const hasValidPredictions =
        analysis.predictions && analysis.predictions.length > 0;

      if (!hasValidPredictions) {
        // No predictions found on this retry attempt
        // Keep record in 'pending' state but increment retry_count
        // Will auto-escalate to 'out_of_subject' when retry_count reaches MAX_RETRY_ATTEMPTS
        logger.info(
          `📋 Financial content detected but no specific predictions for video ${
            record.video_id
          } (attempt ${retryNumber + 1}/${this.MAX_RETRY_ATTEMPTS})`
        );

        // Determine if this is the final retry attempt
        const isFinalAttempt = nextRetryCount >= this.MAX_RETRY_ATTEMPTS;

        if (isFinalAttempt) {
          // Final attempt failed - escalate to out_of_subject
          logger.warn(
            `⚠️ Max retries reached for ${record.video_id}, marking as out_of_subject`
          );
          await supabaseService.recordVideoAnalysis({
            videoId: record.video_id,
            channelId: record.channel_id,
            channelName: record.channel_name,
            videoTitle: record.video_title,
            postDate: record.post_date,
            transcriptSummary: analysis.transcript_summary,
            predictions: [],
            aiModifications: analysis.ai_modifications,
            language: analysis.language,
            rawTranscript: transcriptText,
            hasTranscript: !!transcriptText,
            aiAnalysisSuccess: true,
            hasFinancialContent: false,
            aiModel: globalAIAnalyzer.getModelName(),
            context: {
              isRetry: true,
              retryAttemptNumber: nextRetryCount,
              previousRecordId: record.id,
              errorMessage: `Max retries reached: ${nextRetryCount}/${this.MAX_RETRY_ATTEMPTS}`,
            },
            qualityScore: analysis.quality_score,
            qualityBreakdown: analysis.quality_breakdown,
          });
        } else {
          // Not final attempt yet - keep pending, will retry next time
          await this.updateRetryStatus(
            record.id,
            nextRetryCount,
            `No predictions found on attempt ${retryNumber + 1}, will retry`
          );
        }

        return {
          success: true, // Count as success to process next record
          transcriptFound: true,
          transcriptSource,
          predictionsFound: 0,
        };
      }

      // Success: Found predictions! Update record and mark as analyzed
      logger.info(
        `✅ Successfully extracted predictions for video ${record.video_id}`,
        {
          predictionsFound: analysis.predictions.length,
          modifications: analysis.ai_modifications.length,
          language: analysis.language,
          transcriptSource,
          processingTime: Date.now() - startTime,
        }
      );

      // Update the existing record with new results and mark as analyzed
      await supabaseService.recordVideoAnalysis({
        videoId: record.video_id,
        channelId: record.channel_id,
        channelName: record.channel_name,
        videoTitle: record.video_title,
        postDate: record.post_date,
        transcriptSummary: analysis.transcript_summary,
        predictions: analysis.predictions,
        aiModifications: analysis.ai_modifications,
        language: analysis.language,
        rawTranscript: transcriptText,
        hasTranscript: !!transcriptText,
        aiAnalysisSuccess: true,
        hasFinancialContent: true,
        aiModel: globalAIAnalyzer.getModelName(),
        context: {
          isRetry: true,
          retryAttemptNumber: nextRetryCount,
          previousRecordId: record.id,
          errorMessage: `Retry successful: Extracted ${analysis.predictions.length} predictions`,
        },
        qualityScore: analysis.quality_score,
        qualityBreakdown: analysis.quality_breakdown,
      });

      // Mark retry as successful
      await this.markRetrySuccess(
        record.id,
        analysis.predictions.length,
        transcriptSource
      );

      // Record successful metrics
      RateLimitMonitor.recordRequest(
        "retry-record",
        true,
        Date.now() - startTime
      );

      return {
        success: true,
        transcriptFound: true,
        transcriptSource,
        predictionsFound: analysis.predictions.length,
      };
    } catch (error) {
      const errorMessage = (error as Error).message;
      await this.updateRetryStatus(record.id, retryNumber, errorMessage);

      const isRateLimitError =
        errorMessage.includes("429") ||
        errorMessage.includes("rate limit") ||
        errorMessage.includes("too many requests");

      logger.error(`❌ Retry failed for video ${record.video_id}`, {
        error,
        transcriptSource,
        processingTime: Date.now() - startTime,
        isRateLimitError,
      });

      // Record failed metrics
      RateLimitMonitor.recordRequest(
        "retry-record",
        false,
        Date.now() - startTime,
        isRateLimitError
      );

      return {
        success: false,
        transcriptFound: false,
        transcriptSource,
        predictionsFound: 0,
        error: errorMessage,
      };
    }
  }

  // Enhanced out-of-subject validation with global language support
  private enhancedOutOfSubjectValidation(
    analysis: any,
    transcriptText: string
  ): { isOutOfSubject: boolean; reason: string } {
    const lowerTranscript = transcriptText.toLowerCase();

    // Universal financial keywords (work across all languages)
    const universalFinancialKeywords = [
      "stock",
      "market",
      "investment",
      "trading",
      "price",
      "trend",
      "analysis",
      "prediction",
      "forecast",
      "bullish",
      "bearish",
      "buy",
      "sell",
      "hold",
      "economy",
      "economic",
      "finance",
      "financial",
      "currency",
      "crypto",
      "gold",
      "silver",
      "oil",
      "inflation",
      "interest",
      "rate",
      "recession",
      "growth",
      "decline",
      "gain",
      "loss",
      "profit",
      "portfolio",
      "asset",
      "bond",
      "etf",
      "fund",
      "index",
      "derivative",
      "hedge",
      "dividend",
      "earnings",
      "revenue",
      "valuation",
      "multiple",
    ];

    // Non-financial keywords that indicate out-of-subject content
    const nonFinancialKeywords = [
      // Entertainment
      "film",
      "movie",
      "music",
      "song",
      "artist",
      "celebrity",
      "tv show",
      "gaming",
      "game",
      "video game",
      "esports",
      "streamer",
      "playthrough",
      // Cooking/Food
      "recipe",
      "cook",
      "cooking",
      "food",
      "restaurant",
      "chef",
      "kitchen",
      // Sports (general, not financial)
      "football",
      "soccer",
      "basketball",
      "tennis",
      "olympics",
      "sports",
      // Technology (general, not financial)
      "software",
      "app",
      "phone",
      "computer",
      "tech review",
      "unboxing",
      // Lifestyle
      "travel",
      "vacation",
      "fashion",
      "beauty",
      "fitness",
      "health",
    ];

    // Count financial terms
    const universalCount = universalFinancialKeywords.filter((keyword) =>
      lowerTranscript.includes(keyword)
    ).length;

    const nonFinancialCount = nonFinancialKeywords.filter((keyword) =>
      lowerTranscript.includes(keyword)
    ).length;

    // Enhanced decision logic
    const totalFinancialTerms = universalCount;

    // Transcript quality checks
    const isLongEnough = transcriptText.length >= 200;
    const hasSubstantialContent = transcriptText.length >= 500;

    // Decision matrix
    if (totalFinancialTerms >= 3) {
      return {
        isOutOfSubject: false,
        reason: "Contains substantial financial terminology",
      };
    }

    if (totalFinancialTerms >= 1 && hasSubstantialContent) {
      return {
        isOutOfSubject: false,
        reason: "Contains financial content with substantial discussion",
      };
    }

    if (nonFinancialCount >= 2 && totalFinancialTerms === 0) {
      return {
        isOutOfSubject: true,
        reason: "Contains primarily non-financial entertainment content",
      };
    }

    if (!isLongEnough) {
      return {
        isOutOfSubject: true,
        reason: "Transcript too short to determine financial content",
      };
    }

    // Default: assume it's financial content if we can't clearly classify it as non-financial
    return {
      isOutOfSubject: false,
      reason:
        "Content appears to be financial or unclear classification - avoiding false positive",
    };
  }

  // Update retry status for a record
  private async updateRetryStatus(
    recordId: string,
    retryCount: number,
    reason: string
  ): Promise<void> {
    try {
      await supabaseService
        .getClient()
        .from("finfluencer_predictions")
        .update({
          retry_count: retryCount, // Incremented: 0 → 1, 1 → 2, 2 → 3
          last_retry_at: new Date().toISOString(),
          retry_reason: reason,
          updated_at: new Date().toISOString(), // Always update timestamp
        })
        .eq("id", recordId);
    } catch (error) {
      logger.error("Error updating retry status", { recordId, error });
    }
  }

  // Mark a record as successfully retried with proper tracking
  private async markRetrySuccess(
    recordId: string,
    predictionsExtracted: number = 0,
    transcriptSource: string = "unknown"
  ): Promise<void> {
    try {
      await supabaseService
        .getClient()
        .from("finfluencer_predictions")
        .update({
          retry_count: this.MAX_RETRY_ATTEMPTS, // Set to max to prevent further retries
          last_retry_at: new Date().toISOString(),
          retry_reason: `Retry successful: Extracted ${predictionsExtracted} predictions from ${transcriptSource}`,
          subject_outcome: "analyzed", // Mark as analyzed (complete)
          updated_at: new Date().toISOString(),
        })
        .eq("id", recordId);
    } catch (error) {
      logger.error("Error marking retry as successful", { recordId, error });
    }
  }

  // Get retry statistics including rate limit metrics and transcript reuse
  async getRetryStatistics(): Promise<{
    totalEligible: number;
    maxAttemptsReached: number;
    rateLimitStats?: any;
    circuitBreakerStatus?: any;
  }> {
    try {
      const { data, error } = await supabaseService
        .getClient()
        .from("finfluencer_predictions")
        .select("retry_count, last_retry_at, subject_outcome, raw_transcript")
        .eq("subject_outcome", "pending") // Find records with pending status
        .lt("retry_count", this.MAX_RETRY_ATTEMPTS); // Only those not yet maxed out

      if (error) {
        throw error;
      }

      const totalEligible = data?.length || 0;
      const maxAttemptsReached =
        data?.filter((r) => (r.retry_count || 0) >= this.MAX_RETRY_ATTEMPTS)
          .length || 0;
      const withSavedTranscripts =
        data?.filter(
          (r) => r.raw_transcript && r.raw_transcript.trim().length >= 50
        ).length || 0;

      return {
        totalEligible,
        maxAttemptsReached,
        rateLimitStats: RateLimitMonitor.getStats("retry-service"),
        circuitBreakerStatus: this.circuitBreaker.getStatus(),
      };
    } catch (error) {
      logger.error("Error getting retry statistics", { error });
      return {
        totalEligible: 0,
        maxAttemptsReached: 0,
        rateLimitStats: null,
        circuitBreakerStatus: this.circuitBreaker.getStatus(),
      };
    }
  }

  // Reset rate limiting metrics (for testing or manual reset)
  async resetMetrics(): Promise<void> {
    try {
      RateLimitMonitor.reset("retry-service");
      RateLimitMonitor.reset("retry-batch");
      RateLimitMonitor.reset("retry-record");
      logger.info("📊 Rate limiting metrics reset");
    } catch (error) {
      logger.error("Error resetting metrics", { error });
    }
  }
}

// Export singleton instance
export const retryService = new RetryService();
