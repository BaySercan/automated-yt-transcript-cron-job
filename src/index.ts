import { config, validateConfig } from "./config";
import { supabaseService } from "./supabase";
import { youtubeService, YouTubeService } from "./youtube";
import { globalAIAnalyzer } from "./enhancedAnalyzer";
import { rapidapiService } from "./rapidapi";
import { supadataService } from "./supadataService";
import { transcriptAPIService } from "./services/transcriptAPIService";
import { retryService } from "./retryService";
import { combinedPredictionsService } from "./combinedPredictionsService";
import {
  logger,
  setupGracefulShutdown,
  getMemoryUsage,
  parseYouTubeDuration,
} from "./utils";
import { CronJobStats } from "./types";
import { reportingService } from "./services/reportingService";
import { newsService } from "./services/newsService";
import { ConfigurationError } from "./errors";

class FinfluencerTracker {
  private isShuttingDown = false;
  private stats: CronJobStats;

  constructor() {
    this.stats = {
      total_channels: 0,
      processed_channels: 0,
      total_videos: 0,
      processed_videos: 0,
      skipped_videos: 0,
      videos_with_captions: 0,
      videos_without_captions: 0,
      errors: 0,
      start_time: new Date(),
    };
  }

  // Main execution method
  async run(): Promise<void> {
    try {
      // Initialize reporting service
      reportingService.initialize();
      // Initial save to mark run as "running"
      await reportingService.save();

      logger.info("🚀 Starting Finfluencer Tracker Cron Job", {
        version: "2.0.21",
        environment: config.timezone,
        model: config.openrouterModel,
      });

      // Validate configuration
      validateConfig();

      // Test all connections
      await this.testConnections();

      // Process all active channels (new videos since last_checked_at)
      await this.processAllChannels();

      // GAP DETECTION: Check for missed videos since START_DATE
      await this.detectAndProcessMissedVideos();

      // Process failed predictions (idle-time retry)
      await this.processFailedPredictions();

      // Analyze unprocessed transcripts with pagination
      await this.analyzeUnprocessedTranscripts();

      // Process combined predictions (AI enrichment + price data)
      await this.processCombinedPredictions();

      // Process News (Fetch, Scrape, Analyze)
      await newsService.processNews();

      // Finalize and display report
      reportingService.finalize("success");
      reportingService.printCLI();
      await reportingService.save();

      logger.info("✅ Finfluencer Tracker completed successfully");
    } catch (error) {
      logger.error("❌ Finfluencer Tracker failed", { error });
      this.stats.errors++;
      reportingService.addError((error as Error).message);
      reportingService.finalize("failed");
      reportingService.printCLI();
      await reportingService.save();
      throw error;
    } finally {
      this.stats.end_time = new Date();
    }
  }

  // Test all external connections with graceful degradation
  private async testConnections(): Promise<void> {
    logger.info("🔗 Testing external connections...");

    // ========== ESSENTIAL SERVICES (Must Pass) ==========
    logger.info("🔑 Testing essential services...");
    const essentialServices = [
      { name: "Supabase", service: supabaseService },
      { name: "YouTube API", service: youtubeService },
    ];

    for (const { name, service } of essentialServices) {
      try {
        await service.testConnection();
        logger.info(`✅ ${name} connection successful`);
      } catch (error) {
        logger.error(`❌ ${name} connection failed`, { error });
        throw new ConfigurationError(
          `Essential service ${name} is not available: ${
            (error as Error).message
          }`
        );
      }
    }

    // ========== OPTIONAL TRANSCRIPT SERVICES (With Fallbacks) ==========
    logger.info("🎯 Testing optional transcript services...");
    const transcriptServices = [
      {
        name: "RapidAPI",
        service: rapidapiService,
        isConfigured: () => rapidapiService.isConfigured(),
      },
      {
        name: "Supadata Direct",
        service: supadataService,
        isConfigured: () => supadataService.isConfigured(),
      },
      {
        name: "TranscriptAPI",
        service: transcriptAPIService,
        isConfigured: () => transcriptAPIService.isConfigured(),
      },
    ];

    let availableTranscriptServices = 0;
    let transcriptServiceResults: Array<{
      name: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const { name, service, isConfigured } of transcriptServices) {
      if (!isConfigured()) {
        logger.warn(`⚠️ ${name} not configured, skipping connection test`);
        transcriptServiceResults.push({
          name,
          success: false,
          error: "Not configured",
        });
        continue;
      }

      try {
        await service.testConnection();
        logger.info(`✅ ${name} connection successful`);
        transcriptServiceResults.push({ name, success: true });
        availableTranscriptServices++;
      } catch (error) {
        const errorMsg = (error as Error).message;
        logger.warn(`❌ ${name} connection failed: ${errorMsg}`, { error });
        transcriptServiceResults.push({
          name,
          success: false,
          error: errorMsg,
        });
      }
    }

    // ========== VALIDATION: At least one transcript service must be available ==========
    if (availableTranscriptServices === 0) {
      const failedServices = transcriptServiceResults
        .filter((r) => !r.success)
        .map((r) => `${r.name}: ${r.error}`)
        .join(", ");

      logger.error("💥 No transcript services are available!", {
        failedServices,
        availableServices: availableTranscriptServices,
      });
      throw new ConfigurationError(
        `No transcript services available. Failed services: ${failedServices}`
      );
    }

    // ========== LOG SUMMARY ==========
    const successfulServices = transcriptServiceResults
      .filter((r) => r.success)
      .map((r) => r.name);
    const failedServices = transcriptServiceResults
      .filter((r) => !r.success)
      .map((r) => r.name);

    logger.info("📊 Connection Test Summary:", {
      essentialServices: "All passed ✅",
      transcriptServices: {
        total: transcriptServices.length,
        available: availableTranscriptServices,
        successful: successfulServices,
        failed: failedServices.length > 0 ? failedServices : "None",
      },
    });

    // ========== LOG ADDITIONAL INFO ==========
    // Log Supadata credit statistics if available
    if (
      supadataService.isConfigured() &&
      transcriptServiceResults.find((r) => r.name === "Supadata Direct")
        ?.success
    ) {
      try {
        const creditStats = supadataService.getCreditStats();
        logger.info("💳 Supadata Credit Status:", {
          creditsUsed: creditStats.creditsUsed,
          creditsRemaining: creditStats.creditsRemaining,
          activeEndpoint: creditStats.activeEndpoint,
        });
      } catch (error) {
        logger.warn("Failed to get Supadata credit statistics", { error });
      }
    }

    logger.info(
      "🎉 Connection testing completed - Application ready to start!"
    );
  }

  // Process all active channels
  private async processAllChannels(): Promise<void> {
    const channels = await supabaseService.getActiveChannels();
    this.stats.total_channels = channels.length;
    reportingService.setTotalChannels(channels.length);

    logger.info(`📺 Found ${channels.length} active channels to process`);

    // FIRST: Update metadata for ALL active channels
    logger.info("🔄 Updating channel metadata for all active channels...");
    for (const channel of channels) {
      if (this.isShuttingDown) break;
      try {
        const details = await youtubeService.getChannelDetails(
          channel.channel_id.trim()
        );

        // Check for channel name change
        if (details.title && details.title !== channel.channel_name) {
          logger.info(
            `🔄 Channel name changed from "${channel.channel_name}" to "${details.title}". Syncing across database...`
          );
          await supabaseService.syncChannelName(
            channel.channel_id,
            details.title
          );
          // Update local reference
          channel.channel_name = details.title;
        }

        if (details.raw) {
          await supabaseService.updateChannelInfo(
            channel.channel_id,
            details.raw
          );
        }
      } catch (err) {
        logger.warn(
          `Failed to update metadata for channel ${channel.channel_name}`,
          { error: (err as Error).message }
        );
        // Continue to next channel, don't stop processing
      }
      // Small delay to respect rate limits
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    logger.info("✅ Channel metadata update completed");

    for (const channel of channels) {
      if (this.isShuttingDown) {
        logger.info("Shutdown requested, stopping channel processing");
        break;
      }

      try {
        channel.channel_id = channel.channel_id.trim();
        await this.processChannel(channel);
        this.stats.processed_channels++;
        reportingService.incrementChannelsProcessed();
      } catch (error) {
        logger.error(`Failed to process channel ${channel.channel_id}`, {
          error,
        });
        this.stats.errors++;
        reportingService.incrementChannelErrors();
      }

      // Save progress periodically (after each channel)
      await reportingService.save();

      // Small delay between channels to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // GAP DETECTION: Detect and process videos that were missed during previous fetches
  // Compares all videos from YouTube (since START_DATE) with what's in the database
  private async detectAndProcessMissedVideos(): Promise<void> {
    try {
      logger.info("🔍 Starting gap detection for missed videos...");

      const channels = await supabaseService.getActiveChannels();
      const startDate = new Date(config.startDate);
      let totalMissed = 0;
      let totalProcessed = 0;

      for (const channel of channels) {
        if (this.isShuttingDown) break;

        try {
          // 1. Get ALL videos from YouTube since START_DATE
          const allYouTubeVideos = await youtubeService.getChannelVideos(
            channel.channel_id.trim(),
            startDate
          );

          if (allYouTubeVideos.length === 0) {
            continue;
          }

          // 2. Get all video IDs we have in the database for this channel
          const { data: dbVideos, error } = await supabaseService
            .getClient()
            .from("finfluencer_predictions")
            .select("video_id")
            .eq("channel_id", channel.channel_id);

          if (error) {
            logger.error(
              `Failed to fetch DB videos for ${channel.channel_name}`,
              { error }
            );
            continue;
          }

          const dbVideoIds = new Set(dbVideos?.map((v) => v.video_id) || []);

          // 3. Find videos that exist on YouTube but not in our database
          const missedVideos = allYouTubeVideos.filter(
            (video) => !dbVideoIds.has(video.videoId)
          );

          if (missedVideos.length === 0) {
            logger.debug(
              `✅ No missed videos for ${channel.channel_name} (${allYouTubeVideos.length} videos checked)`
            );
            continue;
          }

          logger.warn(
            `⚠️ Found ${missedVideos.length} missed videos for ${channel.channel_name}`,
            {
              channelId: channel.channel_id,
              totalYouTube: allYouTubeVideos.length,
              totalDB: dbVideoIds.size,
              missedCount: missedVideos.length,
            }
          );

          totalMissed += missedVideos.length;

          // 4. Process each missed video
          for (const video of missedVideos) {
            if (this.isShuttingDown) break;

            try {
              logger.info(
                `🔄 Processing missed video: ${video.title} (${video.videoId})`,
                {
                  publishedAt: video.publishedAt,
                  channelName: channel.channel_name,
                }
              );

              // Use the existing processVideo function
              await this.processVideo(video, channel);
              totalProcessed++;

              // Track in reporting
              reportingService.incrementVideosProcessed();

              // Rate limiting delay
              await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (videoError) {
              logger.error(`Failed to process missed video ${video.videoId}`, {
                error: videoError,
              });
              this.stats.errors++;
            }
          }
        } catch (channelError) {
          logger.error(
            `Gap detection failed for channel ${channel.channel_name}`,
            { error: channelError }
          );
        }

        // Delay between channels
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (totalMissed > 0) {
        logger.info(`✅ Gap detection completed`, {
          totalMissedFound: totalMissed,
          totalProcessed,
          totalFailed: totalMissed - totalProcessed,
        });
      } else {
        logger.info("✅ Gap detection completed - no missed videos found");
      }
    } catch (error) {
      logger.error("❌ Gap detection failed", { error });
      this.stats.errors++;
      // Don't throw - gap detection failures shouldn't stop the main process
    }
  }

  // Process failed predictions during idle time
  private async processFailedPredictions(): Promise<void> {
    try {
      logger.info(
        "🔄 Starting idle-time retry processing for failed predictions"
      );

      // Check if we have retry statistics to show potential candidates
      const retryStats = await retryService.getRetryStatistics();

      if (retryStats.totalEligible === 0) {
        logger.info("✅ No failed predictions found that need retry");
        return;
      }

      logger.info(
        `📋 Found ${retryStats.totalEligible} records that may need retry`,
        {
          maxAttemptsReached: retryStats.maxAttemptsReached,
        }
      );

      // Process failed predictions
      await retryService.processFailedPredictions();

      // Get updated statistics
      const finalStats = await retryService.getRetryStatistics();
      logger.info("✅ Retry processing completed", {
        remainingEligible: finalStats.totalEligible,
        maxAttemptsReached: finalStats.maxAttemptsReached,
      });
    } catch (error) {
      logger.error("❌ Retry processing failed", { error });
      this.stats.errors++;
      // Don't throw - retry failures shouldn't stop the main process
    }
  }

  // Analyze transcripts that have been extracted but not yet analyzed
  private async analyzeUnprocessedTranscripts(): Promise<void> {
    try {
      logger.info("🔍 Analyzing unprocessed transcripts...");

      const BATCH_SIZE = 50; // Process in batches of 50
      let offset = 0;
      let totalAnalyzed = 0;
      let hasMoreRecords = true;

      while (hasMoreRecords) {
        // Query for records with transcripts but no analysis (subject_outcome is NULL or ai_model is NULL)
        const { data: unprocessedRecords, error: queryError } =
          await supabaseService
            .getClient()
            .from("finfluencer_predictions")
            .select("*")
            .is("subject_outcome", null)
            .or("ai_model.is.null")
            .not("raw_transcript", "is", null)
            .order("created_at", { ascending: true })
            .range(offset, offset + BATCH_SIZE - 1); // Pagination instead of limit

        if (queryError) {
          logger.error("Failed to query unprocessed transcripts", {
            error: queryError,
          });
          break; // Exit loop on error
        }

        if (!unprocessedRecords || unprocessedRecords.length === 0) {
          hasMoreRecords = false;
          logger.info("✅ All transcripts have been analyzed");
          break;
        }

        const batchNumber = Math.floor(offset / BATCH_SIZE) + 1;
        logger.info(
          `📝 Processing batch ${batchNumber}: Found ${unprocessedRecords.length} unprocessed transcripts`,
          {
            batchNumber,
            count: unprocessedRecords.length,
            offset,
          }
        );

        let analyzedCount = 0;
        let failedCount = 0;

        for (const record of unprocessedRecords) {
          try {
            if (!record.raw_transcript) {
              logger.warn(
                `⚠️ Record ${record.id} has no transcript content, skipping`
              );
              continue;
            }

            logger.info(
              `📊 Analyzing unprocessed transcript: ${record.video_id}`,
              {
                videoId: record.video_id,
                channelId: record.channel_id,
              }
            );

            // Run AI analysis
            const analysis = await globalAIAnalyzer.analyzeTranscript(
              record.raw_transcript,
              record.language || "english"
            );

            if (!analysis) {
              logger.warn(
                `⚠️ No analysis produced for video ${record.video_id}`
              );
              failedCount++;
              continue;
            }

            // Update the record with analysis results
            const { error: updateError } = await supabaseService
              .getClient()
              .from("finfluencer_predictions")
              .update({
                subject_outcome: analysis.subject_outcome || "analyzed",
                predictions: analysis.predictions || [],
                ai_modifications: analysis.ai_modifications || [],
                ai_model: globalAIAnalyzer.getModelName(),
                language: record.language || "english",
                transcript_length: record.raw_transcript.length,
                predictions_found: (analysis.predictions || []).length,
                quality_score: analysis.quality_score,
                quality_breakdown: analysis.quality_breakdown,
              })
              .eq("id", record.id);

            if (updateError) {
              logger.error(`Failed to update record ${record.id}`, {
                error: updateError,
              });
              failedCount++;
              continue;
            }

            analyzedCount++;
            logger.info(`✅ Updated record with analysis results`, {
              videoId: record.video_id,
              predictionsFound: (analysis.predictions || []).length,
            });
          } catch (error) {
            logger.error(
              `Failed to analyze transcript for ${record.video_id}`,
              { error }
            );
            failedCount++;
            continue;
          }
        }

        totalAnalyzed += analyzedCount;
        logger.info("✅ Batch analysis completed", {
          batchNumber,
          analyzedCount,
          failedCount,
          totalProcessed: analyzedCount + failedCount,
          totalSoFar: totalAnalyzed,
        });

        // Update statistics
        this.stats.processed_videos += analyzedCount;

        // Move to next batch
        offset += BATCH_SIZE;

        // If batch wasn't full, we've processed all records
        if (unprocessedRecords.length < BATCH_SIZE) {
          hasMoreRecords = false;
        }

        // Add delay between batches to avoid rate limiting
        if (hasMoreRecords) {
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
        }
      }

      logger.info("✅ All unprocessed transcripts analysis completed", {
        totalAnalyzed,
      });
    } catch (error) {
      logger.error("❌ Unprocessed transcript analysis failed", { error });
      this.stats.errors++;
      // Don't throw - this shouldn't stop the main process
    }
  }

  // Process combined predictions with AI enrichment and price data
  // REFACTORED: Now loops until ALL records are processed (no artificial limit)
  private async processCombinedPredictions(): Promise<void> {
    try {
      logger.info("🔀 Starting combined predictions processing (ALL records)");

      const BATCH_SIZE = 500; // Process in batches of 500
      let totalProcessed = 0;
      let totalInserted = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      let totalPricesFetched = 0;
      let batchNumber = 0;
      let hasMoreRecords = true;

      // Loop until all unprocessed predictions are handled
      while (hasMoreRecords) {
        batchNumber++;
        const batchRequestId = `cron_${Date.now()}_batch${batchNumber}`;

        logger.info(`📦 Processing combined predictions batch ${batchNumber}`, {
          batchSize: BATCH_SIZE,
        });

        const result = await combinedPredictionsService.processPredictions({
          limit: BATCH_SIZE,
          skipPrice: false,
          dryRun: false,
          concurrency: 3,
          retryCount: 3,
          requestId: batchRequestId,
        });

        totalProcessed += result.processed_records;
        totalInserted += result.inserted;
        totalSkipped += result.skipped;
        totalErrors += result.errors;
        totalPricesFetched += result.prices_fetched;

        logger.info(`✅ Batch ${batchNumber} completed`, {
          batchProcessed: result.processed_records,
          batchInserted: result.inserted,
          runningTotal: totalProcessed,
        });

        // If we processed fewer records than batch size, we're done
        if (result.processed_records < BATCH_SIZE) {
          hasMoreRecords = false;
        }

        // Small delay between batches to avoid overwhelming the system
        if (hasMoreRecords) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      logger.info(
        "✅ Combined predictions processing completed (ALL batches)",
        {
          batches: batchNumber,
          totalProcessed,
          totalInserted,
          totalSkipped,
          totalErrors,
          totalPricesFetched,
        }
      );

      // Update statistics
      this.stats.processed_videos += totalInserted;

      // RECONCILIATION: Loop until ALL pending predictions are verified
      await this.reconcileAllPredictions();
    } catch (error) {
      logger.error("❌ Combined predictions processing failed", { error });
      this.stats.errors++;
      // Don't throw - this shouldn't stop the main process
    }
  }

  // Reconcile ALL horizon-passed predictions (no artificial limit)
  private async reconcileAllPredictions(): Promise<void> {
    try {
      logger.info("🔍 Starting prediction reconciliation (ALL records)");

      const BATCH_SIZE = 500;
      let batchNumber = 0;
      let totalReconciled = 0;
      let hasMoreRecords = true;

      while (hasMoreRecords) {
        batchNumber++;

        // Reconcile doesn't return count, so we check via a query
        // We'll run reconcile and if it processes less than batch size, we stop
        await combinedPredictionsService.reconcilePredictions({
          limit: BATCH_SIZE,
          dryRun: false,
          retryCount: 3,
          useAI: false,
          requestId: `reconcile_${Date.now()}_batch${batchNumber}`,
        });

        // Check if there are more pending predictions to process
        const { data: remaining } = await supabaseService
          .getClient()
          .from("combined_predictions")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending")
          .lt("horizon_end_date", new Date().toISOString());

        const remainingCount = remaining?.length ?? 0;

        logger.info(`🔍 Reconciliation batch ${batchNumber} completed`, {
          remainingEligible: remainingCount,
        });

        // If no more eligible records, stop
        if (remainingCount === 0) {
          hasMoreRecords = false;
        }

        // Safety: limit total batches to prevent infinite loops
        if (batchNumber >= 100) {
          logger.warn("⚠️ Reached max reconciliation batches (100), stopping");
          hasMoreRecords = false;
        }

        // Small delay between batches
        if (hasMoreRecords) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      logger.info("✅ Prediction reconciliation completed (ALL batches)", {
        totalBatches: batchNumber,
      });
    } catch (err) {
      logger.warn("Failed to reconcile combined predictions", { error: err });
    }
  }

  // Process a single channel
  private async processChannel(channel: any): Promise<void> {
    logger.info(
      `🔄 Processing channel: ${channel.channel_name} (${channel.channel_id})`
    );
    // Track the latest video published date we've seen so we can advance last_checked_at even on interruption
    let latestVideoDate = channel.last_checked_at
      ? new Date(channel.last_checked_at)
      : new Date(config.startDate);

    try {
      // Determine start date for video fetching
      const lastChecked = channel.last_checked_at
        ? new Date(channel.last_checked_at)
        : new Date(config.startDate);

      // Get new videos since last check
      const videos = await youtubeService.getChannelVideos(
        channel.channel_id,
        lastChecked
      );

      // Filter out live/premiere videos and very short videos
      const filteredVideos = videos
        .filter((video) => !YouTubeService.isLiveOrUpcoming(video))
        .filter((video) => {
          const duration = video.duration
            ? parseYouTubeDuration(video.duration)
            : 0;
          return duration >= 60; // At least 1 minute
        });

      this.stats.total_videos += filteredVideos.length;
      reportingService.setTotalVideos(this.stats.total_videos);

      logger.info(
        `📹 Found ${filteredVideos.length} new videos for ${channel.channel_name}`
      );

      // Process each video - ALWAYS increment processed_videos for every video attempted
      for (const video of filteredVideos) {
        if (this.isShuttingDown) {
          logger.info("Shutdown requested, stopping video processing");
          break;
        }

        // Update latestVideoDate so we can mark progress even if interrupted
        try {
          const published = video.publishedAt
            ? new Date(video.publishedAt)
            : null;
          if (published && published > latestVideoDate)
            latestVideoDate = published;
        } catch (e) {
          // ignore invalid dates
        }

        // Increment processed_videos at the start - this ensures all attempted videos are counted
        this.stats.processed_videos++;
        reportingService.incrementVideosProcessed();

        try {
          await this.processVideo(video, channel);
        } catch (error) {
          logger.error(`Failed to process video ${video.videoId}`, { error });
          this.stats.errors++;
          // continue to next video without throwing so we can still update last_checked_at
        }

        // Add delay between videos to respect rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // BACKFILL: Check for any missed videos between START_DATE and last_checked_at
      if (channel.last_checked_at && !this.isShuttingDown) {
        await this.backfillMissedVideos(channel, filteredVideos);
      }

      logger.info(`✅ Completed processing channel: ${channel.channel_name}`);
    } catch (error) {
      logger.error(`Error processing channel ${channel.channel_id}`, { error });
      throw error;
    } finally {
      // Always attempt to update the channel's last_checked_at with the latest video date we saw
      try {
        const iso = latestVideoDate
          ? latestVideoDate.toISOString()
          : new Date().toISOString();
        await supabaseService.updateChannelLastCheckedWithVideoDate(
          channel.channel_id,
          iso
        );
        logger.info(
          `🔁 Updated last_checked_at for ${channel.channel_name} => ${iso}`
        );
      } catch (e) {
        logger.error(
          `Failed to update last_checked_at for channel ${channel.channel_id}`,
          { error: e }
        );
      }
    }
  }

  /**
   * Backfill: Check for any videos missed between START_DATE and last_checked_at
   * This ensures all videos are processed even if the process was interrupted
   */
  private async backfillMissedVideos(
    channel: any,
    alreadyFetchedVideos: any[]
  ): Promise<void> {
    try {
      const startDate = new Date(config.startDate);
      const lastChecked = new Date(channel.last_checked_at);

      // Only backfill if last_checked_at is after START_DATE
      if (lastChecked <= startDate) {
        logger.debug(
          `No backfill needed for ${channel.channel_name} - already at START_DATE`
        );
        return;
      }

      logger.info(
        `🔍 Checking for missed videos between ${config.startDate} and ${channel.last_checked_at}`
      );

      // Fetch all videos from START_DATE to last_checked_at
      const historicalVideos = await youtubeService.getChannelVideos(
        channel.channel_id,
        startDate,
        lastChecked // Pass end date to limit range
      );

      // Create a set of already fetched video IDs
      const alreadyFetchedIds = new Set(
        alreadyFetchedVideos.map((v) => v.videoId)
      );

      // Filter to only videos not in the current batch
      const potentialMissedVideos = historicalVideos.filter(
        (video) => !alreadyFetchedIds.has(video.videoId)
      );

      // Filter out live/premiere videos and very short videos
      const filteredMissed = potentialMissedVideos
        .filter((video) => !YouTubeService.isLiveOrUpcoming(video))
        .filter((video) => {
          const duration = video.duration
            ? parseYouTubeDuration(video.duration)
            : 0;
          return duration >= 60;
        });

      // Check each video against the database
      let missedCount = 0;
      for (const video of filteredMissed) {
        if (this.isShuttingDown) break;

        const exists = await supabaseService.videoExists(video.videoId);
        if (!exists) {
          missedCount++;
          logger.info(
            `📥 Found missed video: ${video.title} (${video.videoId})`
          );

          try {
            await this.processVideo(video, channel);
            this.stats.processed_videos++;
            reportingService.incrementVideosProcessed();
          } catch (error) {
            logger.error(`Failed to process missed video ${video.videoId}`, {
              error,
            });
            this.stats.errors++;
          }

          // Add delay between videos
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      if (missedCount > 0) {
        logger.info(
          `✅ Backfill complete: Processed ${missedCount} missed videos for ${channel.channel_name}`
        );
      } else {
        logger.debug(`No missed videos found for ${channel.channel_name}`);
      }
    } catch (error) {
      logger.warn(`Backfill check failed for ${channel.channel_name}`, {
        error,
      });
      // Don't throw - backfill failures shouldn't stop the main process
    }
  }

  // Process a single video - FIXED: Now prioritizes RapidAPI for transcript retrieval
  private async processVideo(video: any, channel: any): Promise<void> {
    // Check if video already exists
    const exists = await supabaseService.videoExists(video.videoId);
    if (exists) {
      this.stats.skipped_videos++;
      logger.debug(`Skipping already processed video: ${video.videoId}`);
      return;
    }

    logger.info(`🔍 Processing video: ${video.title} (${video.videoId})`);

    try {
      // Use the centralized 3-tier fallback system in youtubeService
      // This handles: RapidAPI (Tier 1) → Supadata (Tier 2) → TranscriptAPI (Tier 3)
      const transcriptResult = await youtubeService.getVideoTranscript(
        video.videoId,
        video.defaultLanguage
      );

      // Normalize transcript to a string
      const transcriptText =
        typeof transcriptResult === "string"
          ? transcriptResult
          : transcriptResult?.transcript ?? "";

      // Heuristic validation: only accept transcripts that look like real captions/subtitles
      const isValidTranscript = (text: string) => {
        if (!text) return false;
        const trimmed = text.trim();
        if (trimmed.length < 50) return false; // too short to be a real transcript
        // prefer transcripts with line breaks (common in captions) or enough words
        if (trimmed.includes("\n") || trimmed.split(/\s+/).length > 20)
          return true;
        return false;
      };

      const hasValidTranscript = isValidTranscript(transcriptText);

      // If we don't have a valid transcript, record as pending
      if (!hasValidTranscript) {
        logger.warn(
          `❌ [NO TRANSCRIPT] No usable transcript found for video ${video.videoId} from any source. Recording as pending.`
        );

        await supabaseService.recordVideoAnalysis({
          videoId: video.videoId,
          channelId: channel.channel_id,
          channelName: channel.channel_name,
          videoTitle: video.title,
          postDate: video.publishedAt
            ? video.publishedAt.split("T")[0]
            : new Date().toISOString().split("T")[0],
          transcriptSummary: "No subtitles/captions available from any service",
          predictions: [],
          aiModifications: [],
          language: "unknown",
          rawTranscript: null,
          hasTranscript: false,
          aiAnalysisSuccess: false,
          hasFinancialContent: true, // Don't know yet, but assume it could be
          context: { isRetry: false },
        });

        this.stats.videos_without_captions =
          (this.stats.videos_without_captions || 0) + 1;
        reportingService.incrementTranscriptsFailed();
        return;
      }

      // Analyze with AI (only when we have valid captions)
      let analysis: any;
      let analysisSuccess = false;

      try {
        logger.info(`🧠 Starting AI analysis for video ${video.videoId}`);
        analysis = await globalAIAnalyzer.analyzeTranscript(transcriptText, {
          videoId: video.videoId,
          title: video.title,
          channelId: channel.channel_id,
          channelName: channel.channel_name,
          publishedAt: video.publishedAt,
        });

        // Check if analysis returned valid results:
        // - predictions array with at least one item, OR
        // - a non-error transcript_summary.
        if (
          analysis &&
          Array.isArray(analysis.predictions) &&
          (analysis.predictions.length > 0 ||
            (typeof analysis.transcript_summary === "string" &&
              analysis.transcript_summary.trim().length > 0 &&
              !analysis.transcript_summary.toLowerCase().includes("failed") &&
              !analysis.transcript_summary.toLowerCase().includes("error")))
        ) {
          analysisSuccess = true;
          reportingService.incrementTranscriptsFetched(
            "youtube_service",
            transcriptText.length
          );
          reportingService.incrementAIProcessed();
          reportingService.addPredictionsExtracted(analysis.predictions.length);
          logger.info(`✅ AI analysis successful for video ${video.videoId}`, {
            predictionsFound: analysis.predictions.length,
            hasValidSummary: !!analysis.transcript_summary,
          });
        } else {
          logger.warn(
            `⚠️ AI analysis returned invalid/empty results for video ${video.videoId}`,
            {
              hasAnalysis: !!analysis,
              predictionsType: typeof analysis?.predictions,
              predictionsLength: Array.isArray(analysis?.predictions)
                ? analysis.predictions.length
                : "not_array",
              summary: analysis?.transcript_summary,
            }
          );
        }
      } catch (analysisError) {
        logger.error(`❌ AI analysis failed for video ${video.videoId}`, {
          error: (analysisError as Error).message,
        });
        analysis = null;
        analysisSuccess = false;
        reportingService.incrementAIErrors();
      }

      // Determine financial content status based on analysis
      let hasFinancialContent = true;
      let finalSummary = analysis?.transcript_summary || "Analysis completed";

      if (analysis) {
        // Check if this appears to be non-financial content
        const summaryLower = (analysis.transcript_summary || "").toLowerCase();
        const isOutOfSubject =
          summaryLower.includes("out of subject") ||
          summaryLower.includes("no financial") ||
          summaryLower.includes("not financial") ||
          summaryLower.includes("does not appear to be financial");

        if (isOutOfSubject) {
          hasFinancialContent = false;
          finalSummary = analysis.transcript_summary;
          reportingService.incrementOutOfSubject();
        }
      }

      // CRITICAL FIX: Save to database using the unified method with proper parameters
      await supabaseService.recordVideoAnalysis({
        videoId: video.videoId,
        channelId: channel.channel_id,
        channelName: channel.channel_name,
        videoTitle: video.title,
        postDate: video.publishedAt.split("T")[0],
        transcriptSummary: finalSummary,
        predictions: analysis?.predictions || [],
        aiModifications: analysis?.ai_modifications || [],
        language: analysis?.language || "unknown",
        rawTranscript: transcriptText, // CRITICAL: Always save raw transcript when available
        hasTranscript: true, // We have a valid transcript
        aiAnalysisSuccess: analysisSuccess,
        hasFinancialContent: hasFinancialContent,
        aiModel: globalAIAnalyzer.getModelName(),
        qualityScore: analysis?.quality_score,
        qualityBreakdown: analysis?.quality_breakdown,
        context: { isRetry: false },
      });

      // Update channel last_checked_at immediately after successful video processing
      if (video.publishedAt) {
        await supabaseService.updateChannelLastCheckedWithVideoDate(
          channel.channel_id,
          video.publishedAt
        );
        logger.debug(
          `Updated last_checked_at for ${channel.channel_name} to ${video.publishedAt}`
        );
      }

      logger.info(`✅ Successfully processed video: ${video.videoId}`, {
        transcriptLength: transcriptText.length,
        predictionsFound: analysis?.predictions?.length || 0,
        modifications: analysis?.ai_modifications?.length || 0,
        hasFinancialContent: hasFinancialContent,
        hasRawTranscript: true,
        analysisSuccess: analysisSuccess,
      });
      this.stats.videos_with_captions =
        (this.stats.videos_with_captions || 0) + 1;
    } catch (error) {
      logger.error(`Failed to process video ${video.videoId}`, { error });

      // Create a fallback record even if processing fails - use unified method
      try {
        await supabaseService.recordVideoAnalysis({
          videoId: video.videoId,
          channelId: channel.channel_id,
          channelName: channel.channel_name,
          videoTitle: video.title,
          postDate: video.publishedAt
            ? video.publishedAt.split("T")[0]
            : new Date().toISOString().split("T")[0],
          transcriptSummary: `Processing failed: ${(error as Error).message}`,
          predictions: [],
          aiModifications: [],
          language: "unknown",
          rawTranscript: null,
          hasTranscript: false,
          aiAnalysisSuccess: false,
          hasFinancialContent: true, // Could be financial, we just failed to process
          context: {
            isRetry: true,
            retryAttemptNumber: 1,
            errorMessage: (error as Error).message,
          },
        });
      } catch (dbError) {
        logger.error(
          `Failed to create fallback record for video ${video.videoId}`,
          { error: dbError }
        );
      }

      throw error;
    }
  }

  // Log final statistics
  private logFinalStats(): void {
    const duration = this.stats.end_time
      ? Math.round(
          (this.stats.end_time.getTime() - this.stats.start_time.getTime()) /
            1000
        )
      : 0;

    const memory = getMemoryUsage();

    // Add Supadata credit usage to final stats
    const apiStats = youtubeService.getApiStats();

    logger.info("📊 Final Statistics", {
      ...this.stats,
      duration_seconds: duration,
      memory_usage_mb: memory.used,
      success_rate:
        this.stats.total_videos > 0
          ? Math.round(
              (this.stats.processed_videos / this.stats.total_videos) * 100
            )
          : 0,
      supadata_credits_used: apiStats.supadataCredits?.creditsUsed || 0,
      supadata_credits_remaining:
        apiStats.supadataCredits?.creditsRemaining || 100,
    });
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    logger.info("🛑 Starting graceful shutdown...");
    this.isShuttingDown = true;

    // Finalize report as partial
    reportingService.finalize("partial");
    await reportingService.save();

    // Log final Supadata stats
    if (supadataService.isConfigured()) {
      const creditStats = supadataService.getCreditStats();
      logger.info("💳 Final Supadata Credit Status:", {
        creditsUsed: creditStats.creditsUsed,
        creditsRemaining: creditStats.creditsRemaining,
        activeEndpoint: creditStats.activeEndpoint,
      });
    }

    // Log final TranscriptAPI stats
    if (transcriptAPIService.isConfigured()) {
      const creditStats = transcriptAPIService.getCreditStats();
      logger.info("💳 Final TranscriptAPI Credit Status:", {
        creditsUsed: creditStats.creditsUsed,
        creditsRemaining: creditStats.creditsRemaining,
        lastCheck: creditStats.lastCheck,
      });
    }

    // Give some time for ongoing operations to complete
    await new Promise((resolve) => setTimeout(resolve, 5000));

    logger.info("✅ Graceful shutdown completed");
  }

  // Get current stats
  getStats(): CronJobStats {
    return { ...this.stats };
  }
}

// Main execution function
async function main(): Promise<void> {
  const tracker = new FinfluencerTracker();

  // Setup graceful shutdown handlers
  setupGracefulShutdown(() => tracker.shutdown());

  try {
    await tracker.run();

    // Finalize and save report
    reportingService.finalize("success");
    await reportingService.save();
    reportingService.printCLI();

    // Exit with success code
    process.exit(0);
  } catch (error) {
    logger.error("Fatal error in main execution", { error });

    // Finalize and save report as failed
    reportingService.addError((error as Error).message);
    reportingService.finalize("failed");
    await reportingService.save();
    reportingService.printCLI();

    // Exit with error code
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", { promise, reason });
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", { error });
  process.exit(1);
});

// Run the application
if (require.main === module) {
  main().catch((error) => {
    console.error("Application failed to start:", error);
    process.exit(1);
  });
}

export { FinfluencerTracker };
