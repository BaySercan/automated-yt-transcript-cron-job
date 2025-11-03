import { config, validateConfig } from './config';
import { supabaseService } from './supabase';
import { youtubeService, YouTubeService } from './youtube';
import { aiAnalyzer } from './analyzer';
import { rapidapiService } from './rapidapi';
import { retryService } from './retryService';
import { logger, setupGracefulShutdown, getMemoryUsage, parseYouTubeDuration } from './utils';
import { CronJobStats } from './types';
import { ConfigurationError } from './errors';

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
      start_time: new Date()
    };
  }

  // Main execution method
  async run(): Promise<void> {
    try {
      logger.info('🚀 Starting Finfluencer Tracker Cron Job', {
        version: '1.1.13',
        environment: config.timezone,
        model: config.openrouterModel
      });

      // Validate configuration
      validateConfig();

      // Test all connections
      await this.testConnections();

      // Process all active channels
      await this.processAllChannels();

      // Process failed predictions (idle-time retry)
      await this.processFailedPredictions();

      // Log final statistics
      this.logFinalStats();

      logger.info('✅ Finfluencer Tracker completed successfully');
    } catch (error) {
      logger.error('❌ Finfluencer Tracker failed', { error });
      this.stats.errors++;
      throw error;
    } finally {
      this.stats.end_time = new Date();
    }
  }

  // Test all external connections
  private async testConnections(): Promise<void> {
    logger.info('🔗 Testing external connections...');

    try {
      const connectionTests = [
        supabaseService.testConnection(),
        youtubeService.testConnection(),
        aiAnalyzer.testConnection()
      ];

      // Test RapidAPI if configured
      if (rapidapiService.isConfigured()) {
        connectionTests.push(rapidapiService.testConnection());
      } else {
        logger.warn('⚠️ RapidAPI not configured, skipping connection test');
      }

      await Promise.all(connectionTests);

      logger.info('✅ All connections successful');
    } catch (error) {
      throw new ConfigurationError(`Connection test failed: ${(error as Error).message}`);
    }
  }

  // Process all active channels
  private async processAllChannels(): Promise<void> {
    const channels = await supabaseService.getActiveChannels();
    this.stats.total_channels = channels.length;

    logger.info(`📺 Found ${channels.length} active channels to process`);

    for (const channel of channels) {
      if (this.isShuttingDown) {
        logger.info('Shutdown requested, stopping channel processing');
        break;
      }

      try {
        await this.processChannel(channel);
        this.stats.processed_channels++;
      } catch (error) {
        logger.error(`Failed to process channel ${channel.channel_id}`, { error });
        this.stats.errors++;
      }

      // Small delay between channels to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Process failed predictions during idle time
  private async processFailedPredictions(): Promise<void> {
    try {
      logger.info('🔄 Starting idle-time retry processing for failed predictions');
      
      // Check if we have retry statistics to show potential candidates
      const retryStats = await retryService.getRetryStatistics();
      
      if (retryStats.totalEligible === 0) {
        logger.info('✅ No failed predictions found that need retry');
        return;
      }

      logger.info(`📋 Found ${retryStats.totalEligible} records that may need retry`, {
        maxAttemptsReached: retryStats.maxAttemptsReached
      });

      // Process failed predictions
      await retryService.processFailedPredictions();
      
      // Get updated statistics
      const finalStats = await retryService.getRetryStatistics();
      logger.info('✅ Retry processing completed', {
        remainingEligible: finalStats.totalEligible,
        maxAttemptsReached: finalStats.maxAttemptsReached
      });
      
    } catch (error) {
      logger.error('❌ Retry processing failed', { error });
      this.stats.errors++;
      // Don't throw - retry failures shouldn't stop the main process
    }
  }

  // Process a single channel
  private async processChannel(channel: any): Promise<void> {
    logger.info(`🔄 Processing channel: ${channel.channel_name} (${channel.channel_id})`);
    // Track the latest video published date we've seen so we can advance last_checked_at even on interruption
    let latestVideoDate = channel.last_checked_at ? new Date(channel.last_checked_at) : new Date(config.startDate);

    try {
      // Determine start date for video fetching
      const lastChecked = channel.last_checked_at 
        ? new Date(channel.last_checked_at)
        : new Date(config.startDate);

      // Get new videos since last check
      const videos = await youtubeService.getChannelVideos(channel.channel_id, lastChecked);
      
      // Filter out live/premiere videos and very short videos
      const filteredVideos = videos
        .filter(video => !YouTubeService.isLiveOrUpcoming(video))
        .filter(video => {
          const duration = video.duration ? parseYouTubeDuration(video.duration) : 0;
          return duration >= 60; // At least 1 minute
        });

      this.stats.total_videos += filteredVideos.length;

      logger.info(`📹 Found ${filteredVideos.length} new videos for ${channel.channel_name}`);

      // Process each video - ALWAYS increment processed_videos for every video attempted
      for (const video of filteredVideos) {
        if (this.isShuttingDown) {
          logger.info('Shutdown requested, stopping video processing');
          break;
        }

        // Update latestVideoDate so we can mark progress even if interrupted
        try {
          const published = video.publishedAt ? new Date(video.publishedAt) : null;
          if (published && published > latestVideoDate) latestVideoDate = published;
        } catch (e) {
          // ignore invalid dates
        }

        // Increment processed_videos at the start - this ensures all attempted videos are counted
        this.stats.processed_videos++;

        try {
          await this.processVideo(video, channel);
        } catch (error) {
          logger.error(`Failed to process video ${video.videoId}`, { error });
          this.stats.errors++;
          // continue to next video without throwing so we can still update last_checked_at
        }

        // Add delay between videos to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      logger.info(`✅ Completed processing channel: ${channel.channel_name}`);
    } catch (error) {
      logger.error(`Error processing channel ${channel.channel_id}`, { error });
      throw error;
    } finally {
      // Always attempt to update the channel's last_checked_at with the latest video date we saw
      try {
        const iso = latestVideoDate ? latestVideoDate.toISOString() : new Date().toISOString();
        await supabaseService.updateChannelLastCheckedWithVideoDate(channel.channel_id, iso);
        logger.info(`🔁 Updated last_checked_at for ${channel.channel_name} => ${iso}`);
      } catch (e) {
        logger.error(`Failed to update last_checked_at for channel ${channel.channel_id}`, { error: e });
      }
    }
  }

  // Process a single video
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
      // Prefer captions-only retrieval: if youtubeService exposes getVideoCaptions, use it.
      // Otherwise fall back to getVideoTranscript but we'll validate the result to avoid synthesized transcripts.
      let transcriptResult: any;
      if (typeof (youtubeService as any).getVideoCaptions === 'function') {
        transcriptResult = await (youtubeService as any).getVideoCaptions(video.videoId, video.defaultLanguage);
      } else {
        transcriptResult = await youtubeService.getVideoTranscript(video.videoId, video.defaultLanguage);
      }

      // Normalize transcript to a string (some implementations return { transcript, error })
      const transcriptText: string = typeof transcriptResult === 'string'
        ? transcriptResult
        : (transcriptResult?.transcript ?? transcriptResult?.transcriptText ?? '');

      // Heuristic validation: only accept transcripts that look like real captions/subtitles.
      // Reject very short results or ones that look like metadata-only (title/description synthesis).
      const isValidTranscript = (text: string) => {
        if (!text) return false;
        const trimmed = text.trim();
        if (trimmed.length < 50) return false; // too short to be a real transcript
        // prefer transcripts with line breaks (common in captions) or enough words
        if (trimmed.includes('\n') || trimmed.split(/\s+/).length > 20) return true;
        return false;
      };

      if (!isValidTranscript(transcriptText)) {
        // No usable captions available. Create a record so the video is not missed,
        // but do NOT attempt to synthesize a transcript from title/description.
        logger.warn(`No usable captions found for video ${video.videoId}. Creating fallback record (no transcript).`);
        await supabaseService.insertPrediction({
          channel_id: channel.channel_id,
          channel_name: channel.channel_name,
          video_id: video.videoId,
          video_title: video.title,
          post_date: video.publishedAt ? video.publishedAt.split('T')[0] : new Date().toISOString().split('T')[0],
          language: 'unknown',
          transcript_summary: 'No subtitles/captions available',
          predictions: [],
          ai_modifications: []
        });
        this.stats.videos_without_captions = (this.stats.videos_without_captions || 0) + 1;
        return;
      }

      // Analyze with AI (only when we have valid captions)
      const analysis = await aiAnalyzer.analyzeTranscript(transcriptText, {
        videoId: video.videoId,
        title: video.title,
        channelId: channel.channel_id,
        channelName: channel.channel_name,
        publishedAt: video.publishedAt
      });

      // Save to database
      await supabaseService.insertPrediction({
        channel_id: channel.channel_id,
        channel_name: channel.channel_name,
        video_id: video.videoId,
        video_title: video.title,
        post_date: video.publishedAt.split('T')[0],
        language: analysis.language,
        transcript_summary: analysis.transcript_summary,
        predictions: analysis.predictions,
        ai_modifications: analysis.ai_modifications
      });

      // Update channel last_checked_at immediately after successful video processing
      if (video.publishedAt) {
        await supabaseService.updateChannelLastCheckedWithVideoDate(channel.channel_id, video.publishedAt);
        logger.debug(`Updated last_checked_at for ${channel.channel_name} to ${video.publishedAt}`);
      }

      logger.info(`✅ Successfully processed video: ${video.videoId}`, {
        predictionsFound: analysis.predictions.length,
        modifications: analysis.ai_modifications.length
      });
      this.stats.videos_with_captions = (this.stats.videos_with_captions || 0) + 1;
    } catch (error) {
      logger.error(`Failed to process video ${video.videoId}`, { error });
      
      // Create a basic record even if analysis fails
      try {
        await supabaseService.insertPrediction({
          channel_id: channel.channel_id,
          channel_name: channel.channel_name,
          video_id: video.videoId,
          video_title: video.title,
          post_date: video.publishedAt ? video.publishedAt.split('T')[0] : new Date().toISOString().split('T')[0],
          language: 'unknown',
          transcript_summary: `Processing failed: ${(error as Error).message}`,
          predictions: [],
          ai_modifications: []
        });
      } catch (dbError) {
        logger.error(`Failed to create fallback record for video ${video.videoId}`, { error: dbError });
      }
      
      throw error;
    }
  }

  // Log final statistics
  private logFinalStats(): void {
    const duration = this.stats.end_time 
      ? Math.round((this.stats.end_time.getTime() - this.stats.start_time.getTime()) / 1000)
      : 0;

    const memory = getMemoryUsage();

    logger.info('📊 Final Statistics', {
      ...this.stats,
      duration_seconds: duration,
      memory_usage_mb: memory.used,
      success_rate: this.stats.total_videos > 0 
        ? Math.round((this.stats.processed_videos / this.stats.total_videos) * 100)
        : 0
    });
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    logger.info('🛑 Starting graceful shutdown...');
    this.isShuttingDown = true;
    
    // Give some time for ongoing operations to complete
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    logger.info('✅ Graceful shutdown completed');
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
    
    // Exit with success code
    process.exit(0);
  } catch (error) {
    logger.error('Fatal error in main execution', { error });
    
    // Exit with error code
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { error });
  process.exit(1);
});

// Run the application
if (require.main === module) {
  main().catch(error => {
    console.error('Application failed to start:', error);
    process.exit(1);
  });
}

export { FinfluencerTracker };
