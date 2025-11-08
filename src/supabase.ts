import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';
import { FinfluencerChannel, FinfluencerPrediction } from './types';
import { DatabaseError } from './errors';
import { logger, retryWithBackoff } from './utils';

export class SupabaseService {
  private client: SupabaseClient;
  
  constructor() {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  // Test database connection
  async testConnection(): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from('finfluencer_channels')
        .select('count')
        .limit(1);
      
      if (error) {
        throw new DatabaseError(`Database connection failed: ${error.message}`, { cause: error });
      }
      
      logger.info('Database connection successful');
      return true;
    } catch (error) {
      logger.error('Database connection test failed', { error });
      throw error;
    }
  }

  // Fetch all active channels
  async getActiveChannels(): Promise<FinfluencerChannel[]> {
    try {
      const { data, error } = await this.client
        .from('finfluencer_channels')
        .select('*')
        .eq('is_active', true)
        .order('added_at', { ascending: true });

      if (error) {
        throw new DatabaseError(`Failed to fetch active channels: ${error.message}`, { cause: error });
      }

      logger.info(`Fetched ${data?.length || 0} active channels`);
      return data || [];
    } catch (error) {
      logger.error('Error fetching active channels', { error });
      throw error;
    }
  }

  // Update channel's last checked timestamp
  async updateChannelLastChecked(channelId: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('finfluencer_channels')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('channel_id', channelId);

      if (error) {
        throw new DatabaseError(`Failed to update channel last_checked_at: ${error.message}`, { cause: error });
      }

      logger.debug(`Updated last_checked_at for channel ${channelId}`);
    } catch (error) {
      logger.error(`Error updating channel ${channelId}`, { error });
      throw error;
    }
  }

  // Update channel's last checked timestamp with specific video date
  async updateChannelLastCheckedWithVideoDate(channelId: string, latestVideoDate: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('finfluencer_channels')
        .update({ last_checked_at: latestVideoDate })
        .eq('channel_id', channelId);

      if (error) {
        throw new DatabaseError(`Failed to update channel last_checked_at with video date: ${error.message}`, { cause: error });
      }

      logger.debug(`Updated last_checked_at for channel ${channelId} with video date ${latestVideoDate}`);
    } catch (error) {
      logger.error(`Error updating channel ${channelId} with video date`, { error });
      throw error;
    }
  }

  // Check if video already exists in predictions table
  async videoExists(videoId: string): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from('finfluencer_predictions')
        .select('id')
        .eq('video_id', videoId)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
        throw new DatabaseError(`Failed to check video existence: ${error.message}`, { cause: error });
      }

      return !!data;
    } catch (error) {
      logger.error(`Error checking if video ${videoId} exists`, { error });
      throw error;
    }
  }

  // Insert new prediction record
  async insertPrediction(prediction: Omit<FinfluencerPrediction, 'id' | 'created_at'>): Promise<string> {
    try {
      const { data, error } = await this.client
        .from('finfluencer_predictions')
        .insert(prediction)
        .select('id')
        .single();

      if (error) {
        throw new DatabaseError(`Failed to insert prediction: ${error.message}`, { cause: error });
      }

      logger.info(`Inserted prediction for video ${prediction.video_id}`);
      return data.id;
    } catch (error) {
      logger.error(`Error inserting prediction for video ${prediction.video_id}`, { error });
      throw error;
    }
  }

  // Batch insert predictions (for efficiency)
  async insertPredictionsBatch(predictions: Omit<FinfluencerPrediction, 'id' | 'created_at'>[]): Promise<string[]> {
    if (predictions.length === 0) return [];

    try {
      const { data, error } = await this.client
        .from('finfluencer_predictions')
        .insert(predictions)
        .select('id');

      if (error) {
        throw new DatabaseError(`Failed to insert predictions batch: ${error.message}`, { cause: error });
      }

      const insertedIds = data?.map(item => item.id) || [];
      logger.info(`Inserted batch of ${insertedIds.length} predictions`);
      return insertedIds;
    } catch (error) {
      logger.error('Error inserting predictions batch', { error, count: predictions.length });
      throw error;
    }
  }

  // Update prediction with retry results (enhanced with new fields)
  async updatePredictionWithRetry(predictionId: string, updates: {
    transcript_summary: string;
    predictions: any[];
    ai_modifications: any[];
    language: string;
    raw_transcript?: string;
    subject_outcome?: 'pending' | 'out_of_subject' | 'analyzed';
  }): Promise<void> {
    try {
      const updateData: any = {
        transcript_summary: updates.transcript_summary,
        predictions: updates.predictions,
        ai_modifications: updates.ai_modifications,
        language: updates.language,
        updated_at: new Date().toISOString() // Always update timestamp
      };

      // Add optional fields if provided
      if (updates.raw_transcript !== undefined) {
        updateData.raw_transcript = updates.raw_transcript;
      }
      if (updates.subject_outcome !== undefined) {
        updateData.subject_outcome = updates.subject_outcome;
      }

      const { error } = await this.client
        .from('finfluencer_predictions')
        .update(updateData)
        .eq('id', predictionId);

      if (error) {
        throw new DatabaseError(`Failed to update prediction with retry: ${error.message}`, { cause: error });
      }

      logger.debug(`Updated prediction ${predictionId} with retry results`);
    } catch (error) {
      logger.error(`Error updating prediction ${predictionId} with retry`, { error });
      throw error;
    }
  }

  // Mark video as out of subject (no financial predictions)
  async markVideoAsOutOfSubject(predictionId: string, rawTranscript: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('finfluencer_predictions')
        .update({
          predictions: ['Out of subject, no available financial predictions in the video'],
          ai_modifications: [],
          language: 'unknown',
          transcript_summary: 'No financial predictions found in this video content',
          raw_transcript: rawTranscript,
          subject_outcome: 'out_of_subject',
          updated_at: new Date().toISOString()
        })
        .eq('id', predictionId);

      if (error) {
        throw new DatabaseError(`Failed to mark video as out of subject: ${error.message}`, { cause: error });
      }

      logger.info(`Marked prediction ${predictionId} as out of subject`);
    } catch (error) {
      logger.error(`Error marking prediction ${predictionId} as out of subject`, { error });
      throw error;
    }
  }

  // Update only timestamp (for retry attempts)
  async updatePredictionTimestamp(predictionId: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('finfluencer_predictions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', predictionId);

      if (error) {
        throw new DatabaseError(`Failed to update prediction timestamp: ${error.message}`, { cause: error });
      }

      logger.debug(`Updated timestamp for prediction ${predictionId}`);
    } catch (error) {
      logger.error(`Error updating prediction timestamp ${predictionId}`, { error });
      throw error;
    }
  }

  // Get channel statistics
  async getChannelStats(channelId: string): Promise<{
    totalVideos: number;
    lastVideoDate: string | null;
    totalPredictions: number;
  }> {
    try {
      const { data: videos, error: videosError } = await this.client
        .from('finfluencer_predictions')
        .select('post_date')
        .eq('channel_id', channelId);

      if (videosError) {
        throw new DatabaseError(`Failed to get channel videos: ${videosError.message}`, { cause: videosError });
      }

      const totalVideos = videos?.length || 0;
      const lastVideoDate = videos?.length > 0 
        ? videos.sort((a, b) => new Date(b.post_date).getTime() - new Date(a.post_date).getTime())[0].post_date
        : null;

      // Count total predictions (sum of all predictions arrays)
      const totalPredictions = videos?.reduce((sum, video) => {
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
        totalPredictions
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
        .from('finfluencer_channels')
        .select('is_active, last_checked_at');

      if (channelsError) {
        throw new DatabaseError(`Failed to get channels: ${channelsError.message}`, { cause: channelsError });
      }

      const totalChannels = channels?.length || 0;
      const activeChannels = channels?.filter(c => c.is_active).length || 0;
      const lastUpdate = channels?.length > 0
        ? channels
            .filter(c => c.last_checked_at)
            .sort((a, b) => new Date(b.last_checked_at!).getTime() - new Date(a.last_checked_at!).getTime())[0]?.last_checked_at || null
        : null;

      // Get video stats
      const { data: videos, error: videosError } = await this.client
        .from('finfluencer_predictions')
        .select('predictions');

      if (videosError) {
        throw new DatabaseError(`Failed to get videos: ${videosError.message}`, { cause: videosError });
      }

      const totalVideos = videos?.length || 0;
      const totalPredictions = videos?.reduce((sum, video) => {
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
        lastUpdate
      };
    } catch (error) {
      logger.error('Error getting overall stats', { error });
      throw error;
    }
  }

  // Cleanup old records (optional maintenance)
  async cleanupOldRecords(daysToKeep: number = 365): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const { data, error } = await this.client
        .from('finfluencer_predictions')
        .delete()
        .lt('created_at', cutoffDate.toISOString())
        .select('id');

      if (error) {
        throw new DatabaseError(`Failed to cleanup old records: ${error.message}`, { cause: error });
      }

      const deletedCount = data?.length || 0;
      logger.info(`Cleaned up ${deletedCount} old records`);
      return deletedCount;
    } catch (error) {
      logger.error('Error during cleanup', { error });
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
      const channelsTable = await this.checkTableExists('finfluencer_channels');
      const predictionsTable = await this.checkTableExists('finfluencer_predictions');
      
      // Get basic stats
      const stats = await this.getOverallStats();

      return {
        database,
        tables: {
          channels: channelsTable,
          predictions: predictionsTable
        },
        stats
      };
    } catch (error) {
      logger.error('Health check failed', { error });
      return {
        database: false,
        tables: {
          channels: false,
          predictions: false
        },
        stats: null
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
        .select('count')
        .limit(1);

      return !error;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const supabaseService = new SupabaseService();
