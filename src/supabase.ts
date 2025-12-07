import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";
import { FinfluencerChannel, FinfluencerPrediction } from "./types";
import { DatabaseError } from "./errors";
import { logger, retryWithBackoff } from "./utils";

export class SupabaseService {
  private client: SupabaseClient;

  constructor() {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  // Expose client for direct query operations when needed
  get supabase(): SupabaseClient {
    return this.client;
  }

  // Test database connection
  async testConnection(): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from("finfluencer_channels")
        .select("count")
        .limit(1);

      if (error) {
        throw new DatabaseError(
          `Database connection failed: ${error.message}`,
          { cause: error }
        );
      }

      logger.info("Database connection successful");
      return true;
    } catch (error) {
      logger.error("Database connection test failed", { error });
      throw error;
    }
  }

  // Fetch all active channels
  async getActiveChannels(): Promise<FinfluencerChannel[]> {
    try {
      const { data, error } = await this.client
        .from("finfluencer_channels")
        .select("*")
        .eq("is_active", true)
        .order("added_at", { ascending: true });

      if (error) {
        throw new DatabaseError(
          `Failed to fetch active channels: ${error.message}`,
          { cause: error }
        );
      }

      logger.info(`Fetched ${data?.length || 0} active channels`);
      return data || [];
    } catch (error) {
      logger.error("Error fetching active channels", { error });
      throw error;
    }
  }

  // Update channel's last checked timestamp
  async updateChannelLastChecked(channelId: string): Promise<void> {
    try {
      const { error } = await this.client
        .from("finfluencer_channels")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("channel_id", channelId);

      if (error) {
        throw new DatabaseError(
          `Failed to update channel last_checked_at: ${error.message}`,
          { cause: error }
        );
      }

      logger.debug(`Updated last_checked_at for channel ${channelId}`);
    } catch (error) {
      logger.error(`Error updating channel ${channelId}`, { error });
      throw error;
    }
  }

  // Update channel's last checked timestamp with specific video date
  async updateChannelLastCheckedWithVideoDate(
    channelId: string,
    latestVideoDate: string
  ): Promise<void> {
    try {
      const { error } = await this.client
        .from("finfluencer_channels")
        .update({ last_checked_at: latestVideoDate })
        .eq("channel_id", channelId);

      if (error) {
        throw new DatabaseError(
          `Failed to update channel last_checked_at with video date: ${error.message}`,
          { cause: error }
        );
      }

      logger.debug(
        `Updated last_checked_at for channel ${channelId} with video date ${latestVideoDate}`
      );
    } catch (error) {
      logger.error(`Error updating channel ${channelId} with video date`, {
        error,
      });
      throw error;
    }
  }

  // Update channel info (snippet, statistics)
  async updateChannelInfo(channelId: string, info: any): Promise<void> {
    try {
      const { error } = await this.client
        .from("finfluencer_channels")
        .update({
          channel_info: info,
          channel_info_update_date: new Date().toISOString(),
        })
        .eq("channel_id", channelId);

      if (error) {
        throw new DatabaseError(
          `Failed to update channel info: ${error.message}`,
          { cause: error }
        );
      }

      logger.info(`Updated channel info for ${channelId}`);
    } catch (error) {
      logger.error(`Error updating channel info for ${channelId}`, { error });
      throw error;
    }
  }

  // Sync channel name across all tables if it changed
  async syncChannelName(channelId: string, newName: string): Promise<void> {
    try {
      logger.info(
        `🔄 Syncing new channel name "${newName}" for ${channelId} across database...`
      );

      // 1. Update finfluencer_channels
      const { error: channelsError } = await this.client
        .from("finfluencer_channels")
        .update({ channel_name: newName })
        .eq("channel_id", channelId);

      if (channelsError) {
        throw new DatabaseError(
          `Failed to update name in finfluencer_channels: ${channelsError.message}`,
          { cause: channelsError }
        );
      }

      // 2. Update finfluencer_predictions
      const { error: predictionsError } = await this.client
        .from("finfluencer_predictions")
        .update({ channel_name: newName })
        .eq("channel_id", channelId);

      if (predictionsError) {
        throw new DatabaseError(
          `Failed to update name in finfluencer_predictions: ${predictionsError.message}`,
          { cause: predictionsError }
        );
      }

      // 3. Update combined_predictions
      const { error: combinedError } = await this.client
        .from("combined_predictions")
        .update({ channel_name: newName })
        .eq("channel_id", channelId);

      if (combinedError) {
        throw new DatabaseError(
          `Failed to update name in combined_predictions: ${combinedError.message}`,
          { cause: combinedError }
        );
      }

      logger.info(
        `✅ Successfully synced channel name "${newName}" across all tables`
      );
    } catch (error) {
      logger.error(`Failed to sync channel name for ${channelId}`, { error });
      // We don't throw here to avoid stopping the main process, but we log the error
    }
  }

  // Check if video already exists in predictions table
  async videoExists(videoId: string): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from("finfluencer_predictions")
        .select("id")
        .eq("video_id", videoId)
        .single();

      if (error && error.code !== "PGRST116") {
        // PGRST116 is "not found"
        throw new DatabaseError(
          `Failed to check video existence: ${error.message}`,
          { cause: error }
        );
      }

      return !!data;
    } catch (error) {
      logger.error(`Error checking if video ${videoId} exists`, { error });
      throw error;
    }
  }

  // ==================== UNIFIED VIDEO RECORDING SYSTEM ====================
  // This is the single, consistent method for recording all video analysis

  /**
   * Unified method to record video analysis with consistent status management
   *
   * Status Logic:
   * - 'pending' = No transcript available OR transcript saved but AI analysis failed
   * - 'analyzed' = AI analysis completed (success, empty predictions, or meaningful failure)
   * - 'out_of_subject' = Non-financial content detected
   */
  async recordVideoAnalysis(params: {
    // Required fields
    videoId: string;
    channelId: string;
    channelName: string;
    videoTitle: string;
    postDate: string;

    // Analysis results (can be partial)
    transcriptSummary?: string;
    predictions?: any[];
    aiModifications?: any[];
    language?: string;

    // Processing state
    rawTranscript?: string | null;
    hasTranscript?: boolean; // Was transcript successfully retrieved?
    aiAnalysisSuccess?: boolean; // Did AI analysis complete successfully?
    hasFinancialContent?: boolean; // Is this financial content?
    aiModel?: string; // AI model used for analysis

    // Context for status determination
    context: {
      isRetry?: boolean; // Is this a retry attempt?
      retryAttemptNumber?: number;
      errorMessage?: string;
      previousRecordId?: string;
    };
  }): Promise<string> {
    try {
      const {
        videoId,
        channelId,
        channelName,
        videoTitle,
        postDate,
        transcriptSummary = "No summary available",
        predictions = [],
        aiModifications = [],
        language = "unknown",
        rawTranscript = null,
        hasTranscript = false,
        aiAnalysisSuccess = false,
        hasFinancialContent = true,
        aiModel,
        context,
      } = params;

      // Determine subject outcome based on analysis results
      const subjectOutcome = this.determineSubjectOutcome({
        hasTranscript,
        aiAnalysisSuccess,
        hasFinancialContent,
        predictions: predictions,
        transcriptSummary,
        isRetry: context.isRetry,
      });

      // Build the record data with consistent field mapping
      const recordData: any = {
        channel_id: channelId,
        channel_name: channelName,
        video_id: videoId,
        video_title: videoTitle,
        post_date: postDate,
        language: language,
        transcript_summary: transcriptSummary,
        predictions: predictions,
        ai_modifications: aiModifications,
        ai_model: aiModel,
        updated_at: new Date().toISOString(),
      };

      // Always include raw transcript if available
      if (rawTranscript && rawTranscript.trim().length > 0) {
        recordData.raw_transcript = rawTranscript;
        logger.debug(
          `Including raw_transcript in record (${rawTranscript.length} characters) for video ${videoId}`
        );
      }

      // Include subject outcome
      recordData.subject_outcome = subjectOutcome;

      // Include retry information if this is a retry
      if (context.isRetry && context.retryAttemptNumber !== undefined) {
        recordData.retry_count = context.retryAttemptNumber;
        recordData.last_retry_at = new Date().toISOString();
        if (context.errorMessage) {
          recordData.retry_reason = context.errorMessage;
        }
      }

      // Determine if this is an update or insert
      const isUpdate = context.isRetry && context.previousRecordId;
      const tableOperation = isUpdate ? "update" : "insert";
      const queryBuilder = isUpdate
        ? this.client
            .from("finfluencer_predictions")
            .update(recordData)
            .eq("id", context.previousRecordId)
        : this.client.from("finfluencer_predictions").insert(recordData);

      const operation = isUpdate
        ? await queryBuilder.select("id").single()
        : await queryBuilder.select("id").single();

      if (operation.error) {
        throw new DatabaseError(
          `Failed to ${tableOperation} video analysis: ${operation.error.message}`,
          {
            cause: operation.error,
          }
        );
      }

      const recordId = operation.data.id;

      logger.info(
        `📝 ${isUpdate ? "Updated" : "Recorded"} video analysis for ${videoId}`,
        {
          recordId,
          subjectOutcome,
          hasTranscript,
          hasRawTranscript: !!rawTranscript,
          aiAnalysisSuccess,
          predictionsCount: predictions.length,
          isRetry: context.isRetry,
        }
      );

      return recordId;
    } catch (error) {
      logger.error(`Failed to record video analysis for ${params.videoId}`, {
        error: (error as Error).message,
        params: {
          hasTranscript: params.hasTranscript,
          aiAnalysisSuccess: params.aiAnalysisSuccess,
          predictionsCount: params.predictions?.length || 0,
        },
      });
      throw error;
    }
  }

  /**
   * Determine the appropriate subject outcome based on processing results
   */
  private determineSubjectOutcome(params: {
    hasTranscript: boolean;
    aiAnalysisSuccess: boolean;
    hasFinancialContent: boolean;
    predictions: any[];
    transcriptSummary: string;
    isRetry?: boolean;
  }): "pending" | "analyzed" | "out_of_subject" {
    const {
      hasTranscript,
      aiAnalysisSuccess,
      hasFinancialContent,
      predictions,
      transcriptSummary,
      isRetry,
    } = params;

    // No transcript available at all
    if (!hasTranscript) {
      return "pending";
    }

    // Non-financial content detected
    if (
      !hasFinancialContent ||
      transcriptSummary.toLowerCase().includes("out of subject")
    ) {
      return "out_of_subject";
    }

    // Has transcript but AI analysis failed
    if (!aiAnalysisSuccess) {
      return "pending";
    }

    // AI analysis completed - check if we have meaningful results
    const hasValidPredictions = predictions && predictions.length > 0;
    const hasValidSummary =
      transcriptSummary &&
      !transcriptSummary.toLowerCase().includes("failed") &&
      !transcriptSummary.toLowerCase().includes("error") &&
      !transcriptSummary.toLowerCase().includes("no analysis");

    // If we have either predictions OR a valid summary, mark as analyzed
    if (hasValidPredictions || hasValidSummary) {
      return "analyzed";
    }

    // AI completed but no meaningful results
    return "pending";
  }

  // ==================== LEGACY METHODS (DEPRECATED) ====================
  // These methods are kept for backward compatibility but should be replaced
  // with recordVideoAnalysis() in the future

  // Insert new prediction record - LEGACY (use recordVideoAnalysis instead)
  async insertPrediction(
    prediction: Omit<FinfluencerPrediction, "id" | "created_at">
  ): Promise<string> {
    logger.warn(
      "Using deprecated insertPrediction method - should use recordVideoAnalysis"
    );

    // Convert legacy format to new format
    return this.recordVideoAnalysis({
      videoId: prediction.video_id,
      channelId: prediction.channel_id,
      channelName: prediction.channel_name,
      videoTitle: prediction.video_title,
      postDate: prediction.post_date,
      transcriptSummary: prediction.transcript_summary,
      predictions: prediction.predictions,
      aiModifications: prediction.ai_modifications,
      language: prediction.language,
      rawTranscript: prediction.raw_transcript || null,
      hasTranscript: !!prediction.raw_transcript,
      aiAnalysisSuccess:
        prediction.predictions.length > 0 ||
        (prediction.transcript_summary &&
          !prediction.transcript_summary.toLowerCase().includes("no analysis")),
      hasFinancialContent: prediction.subject_outcome !== "out_of_subject",
      context: { isRetry: false },
    });
  }

  // Batch insert predictions (for efficiency) - LEGACY
  async insertPredictionsBatch(
    predictions: Omit<FinfluencerPrediction, "id" | "created_at">[]
  ): Promise<string[]> {
    logger.warn(
      "Using deprecated insertPredictionsBatch method - should use recordVideoAnalysis in loop"
    );

    if (predictions.length === 0) return [];

    const results: string[] = [];

    for (const prediction of predictions) {
      try {
        const id = await this.insertPrediction(prediction);
        results.push(id);
      } catch (error) {
        logger.error("Failed to insert prediction in batch", {
          error,
          videoId: prediction.video_id,
        });
        // Continue with other predictions
      }
    }

    return results;
  }

  // Update prediction with retry results - LEGACY (use recordVideoAnalysis with isRetry: true)
  async updatePredictionWithRetry(
    predictionId: string,
    updates: {
      transcript_summary: string;
      predictions: any[];
      ai_modifications: any[];
      language: string;
      raw_transcript?: string;
      subject_outcome?: "pending" | "out_of_subject" | "analyzed";
    }
  ): Promise<void> {
    logger.warn(
      "Using deprecated updatePredictionWithRetry method - should use recordVideoAnalysis with isRetry: true"
    );

    try {
      // Get the existing record to convert to new format
      const { data: existingRecord, error: fetchError } = await this.client
        .from("finfluencer_predictions")
        .select("*")
        .eq("id", predictionId)
        .single();

      if (fetchError || !existingRecord) {
        throw new DatabaseError(
          `Failed to fetch existing record for update: ${fetchError?.message}`
        );
      }

      // Use recordVideoAnalysis to update
      await this.recordVideoAnalysis({
        videoId: existingRecord.video_id,
        channelId: existingRecord.channel_id,
        channelName: existingRecord.channel_name,
        videoTitle: existingRecord.video_title,
        postDate: existingRecord.post_date,
        transcriptSummary: updates.transcript_summary,
        predictions: updates.predictions,
        aiModifications: updates.ai_modifications,
        language: updates.language,
        rawTranscript: updates.raw_transcript || existingRecord.raw_transcript,
        hasTranscript: !!(
          updates.raw_transcript || existingRecord.raw_transcript
        ),
        aiAnalysisSuccess: true, // If we're updating with results, analysis succeeded
        hasFinancialContent: updates.subject_outcome !== "out_of_subject",
        context: {
          isRetry: true,
          retryAttemptNumber: (existingRecord.retry_count || 0) + 1,
          previousRecordId: predictionId,
        },
      });
    } catch (error) {
      logger.error(`Error updating prediction ${predictionId} with retry`, {
        error,
      });
      throw error;
    }
  }

  // Mark video as out of subject - LEGACY (use recordVideoAnalysis with hasFinancialContent: false)
  async markVideoAsOutOfSubject(
    predictionId: string,
    rawTranscript: string
  ): Promise<void> {
    logger.warn(
      "Using deprecated markVideoAsOutOfSubject method - should use recordVideoAnalysis with hasFinancialContent: false"
    );

    try {
      // Get the existing record
      const { data: existingRecord, error: fetchError } = await this.client
        .from("finfluencer_predictions")
        .select("*")
        .eq("id", predictionId)
        .single();

      if (fetchError || !existingRecord) {
        throw new DatabaseError(
          `Failed to fetch existing record: ${fetchError?.message}`
        );
      }

      // Use recordVideoAnalysis to mark as out of subject
      await this.recordVideoAnalysis({
        videoId: existingRecord.video_id,
        channelId: existingRecord.channel_id,
        channelName: existingRecord.channel_name,
        videoTitle: existingRecord.video_title,
        postDate: existingRecord.post_date,
        transcriptSummary:
          "No financial predictions found in this video content",
        predictions: [
          "Out of subject, no available financial predictions in the video",
        ],
        aiModifications: [],
        language: "unknown",
        rawTranscript: rawTranscript,
        hasTranscript: true,
        aiAnalysisSuccess: true,
        hasFinancialContent: false, // This is the key difference
        context: { isRetry: true, previousRecordId: predictionId },
      });
    } catch (error) {
      logger.error(
        `Error marking prediction ${predictionId} as out of subject`,
        { error }
      );
      throw error;
    }
  }

  // Update only timestamp (for retry attempts) - LEGACY
  async updatePredictionTimestamp(predictionId: string): Promise<void> {
    logger.warn(
      "Using deprecated updatePredictionTimestamp method - should use recordVideoAnalysis"
    );

    try {
      const { error } = await this.client
        .from("finfluencer_predictions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", predictionId);

      if (error) {
        throw new DatabaseError(
          `Failed to update prediction timestamp: ${error.message}`,
          { cause: error }
        );
      }

      logger.debug(`Updated timestamp for prediction ${predictionId}`);
    } catch (error) {
      logger.error(`Error updating prediction timestamp ${predictionId}`, {
        error,
      });
      throw error;
    }
  }

  // ==================== UTILITY METHODS ====================

  // Get channel statistics
  async getChannelStats(channelId: string): Promise<{
    totalVideos: number;
    lastVideoDate: string | null;
    totalPredictions: number;
  }> {
    try {
      const { data: videos, error: videosError } = await this.client
        .from("finfluencer_predictions")
        .select("post_date")
        .eq("channel_id", channelId);

      if (videosError) {
        throw new DatabaseError(
          `Failed to get channel videos: ${videosError.message}`,
          { cause: videosError }
        );
      }

      const totalVideos = videos?.length || 0;
      const lastVideoDate =
        videos?.length > 0
          ? videos.sort(
              (a, b) =>
                new Date(b.post_date).getTime() -
                new Date(a.post_date).getTime()
            )[0].post_date
          : null;

      // Count total predictions (sum of all predictions arrays)
      const totalPredictions =
        videos?.reduce((sum, video) => {
          try {
            const predictions = JSON.parse((video as any).predictions as any);
            return sum + (Array.isArray(predictions) ? predictions.length : 0);
          } catch {
            return sum;
          }
        }, 0) || 0;

      return {
        totalVideos,
        lastVideoDate,
        totalPredictions,
      };
    } catch (error) {
      logger.error(`Error getting stats for channel ${channelId}`, { error });
      throw error;
    }
  }

  // Get overall statistics
  async getOverallStats(): Promise<{
    totalChannels: number;
    activeChannels: number;
    totalVideos: number;
    totalPredictions: number;
    lastUpdate: string | null;
  }> {
    try {
      // Get channel stats
      const { data: channels, error: channelsError } = await this.client
        .from("finfluencer_channels")
        .select("is_active, last_checked_at");

      if (channelsError) {
        throw new DatabaseError(
          `Failed to get channels: ${channelsError.message}`,
          { cause: channelsError }
        );
      }

      const totalChannels = channels?.length || 0;
      const activeChannels = channels?.filter((c) => c.is_active).length || 0;
      const lastUpdate =
        channels?.length > 0
          ? channels
              .filter((c) => c.last_checked_at)
              .sort(
                (a, b) =>
                  new Date(b.last_checked_at!).getTime() -
                  new Date(a.last_checked_at!).getTime()
              )[0]?.last_checked_at || null
          : null;

      // Get video stats
      const { data: videos, error: videosError } = await this.client
        .from("finfluencer_predictions")
        .select("predictions");

      if (videosError) {
        throw new DatabaseError(
          `Failed to get videos: ${videosError.message}`,
          { cause: videosError }
        );
      }

      const totalVideos = videos?.length || 0;
      const totalPredictions =
        videos?.reduce((sum, video) => {
          try {
            const predictions = video.predictions as any;
            return sum + (Array.isArray(predictions) ? predictions.length : 0);
          } catch {
            return sum;
          }
        }, 0) || 0;

      return {
        totalChannels,
        activeChannels,
        totalVideos,
        totalPredictions,
        lastUpdate,
      };
    } catch (error) {
      logger.error("Error getting overall stats", { error });
      throw error;
    }
  }

  // Get records that need retry with smart transcript checking
  async getRecordsForRetry(): Promise<
    Array<{
      id: string;
      video_id: string;
      channel_id: string;
      video_title: string;
      retry_count: number;
      last_retry_at: string | null;
      retry_reason: string | null;
      post_date: string;
      raw_transcript?: string | null;
      hasTranscript: boolean;
    }>
  > {
    try {
      const { data, error } = await this.client
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
        .eq("subject_outcome", "pending") // Only retry pending records
        .or(`retry_count.is.null,retry_count.lt.3`) // Haven't exceeded max retries
        .order("post_date", { ascending: false }) // Newer first
        .limit(20);

      if (error) {
        throw new DatabaseError(
          `Failed to fetch retry candidates: ${error.message}`,
          { cause: error }
        );
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
          raw_transcript: record.raw_transcript,
          hasTranscript: !!(
            record.raw_transcript && record.raw_transcript.trim().length >= 50
          ),
        })) || []
      );
    } catch (error) {
      logger.error("Error fetching records for retry", { error });
      throw error;
    }
  }

  // Cleanup old records (optional maintenance)
  async cleanupOldRecords(daysToKeep: number = 365): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const { data, error } = await this.client
        .from("finfluencer_predictions")
        .delete()
        .lt("created_at", cutoffDate.toISOString())
        .select("id");

      if (error) {
        throw new DatabaseError(
          `Failed to cleanup old records: ${error.message}`,
          { cause: error }
        );
      }

      const deletedCount = data?.length || 0;
      logger.info(`Cleaned up ${deletedCount} old records`);
      return deletedCount;
    } catch (error) {
      logger.error("Error during cleanup", { error });
      throw error;
    }
  }

  // Health check for the service
  async healthCheck(): Promise<{
    database: boolean;
    tables: {
      channels: boolean;
      predictions: boolean;
    };
    stats: any;
  }> {
    try {
      const database = await this.testConnection();

      // Check table existence
      const channelsTable = await this.checkTableExists("finfluencer_channels");
      const predictionsTable = await this.checkTableExists(
        "finfluencer_predictions"
      );

      // Get basic stats
      const stats = await this.getOverallStats();

      return {
        database,
        tables: {
          channels: channelsTable,
          predictions: predictionsTable,
        },
        stats,
      };
    } catch (error) {
      logger.error("Health check failed", { error });
      return {
        database: false,
        tables: {
          channels: false,
          predictions: false,
        },
        stats: null,
      };
    }
  }

  // Get the underlying Supabase client for custom queries
  getClient(): SupabaseClient {
    return this.client;
  }

  // Helper method to check if table exists
  private async checkTableExists(tableName: string): Promise<boolean> {
    try {
      const { error } = await this.client
        .from(tableName)
        .select("count")
        .limit(1);

      return !error;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const supabaseService = new SupabaseService();
