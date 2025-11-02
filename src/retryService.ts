import { supabaseService } from './supabase';
import { rapidapiService } from './rapidapi';
import { aiAnalyzer } from './analyzer';
import { logger, retryWithBackoff, isValidYouTubeVideoId } from './utils';
import { FinfluencerPrediction } from './types';

export interface RetryRecord {
  id: string;
  video_id: string;
  channel_id: string;
  video_title: string;
  retry_count: number;
  last_retry_at: string | null;
  retry_reason: string | null;
  default_language?: string;
  post_date: string;
}

export interface RetryResult {
  success: boolean;
  transcriptFound: boolean;
  predictionsFound: number;
  error?: string;
}

export class RetryService {
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly BATCH_SIZE = 10;
  private readonly DELAY_BETWEEN_BATCHES = 5000; // 5 seconds

  // Main method to process all failed predictions
  async processFailedPredictions(): Promise<void> {
    try {
      logger.info('🔄 Starting retry process for failed predictions');

      // Get records that need retry (newer first)
      const recordsToRetry = await this.getRecordsNeedingRetry();
      
      if (recordsToRetry.length === 0) {
        logger.info('✅ No records found that need retry');
        return;
      }

      logger.info(`📋 Found ${recordsToRetry.length} records to retry`);

      // Process in batches to avoid overwhelming the system
      for (let i = 0; i < recordsToRetry.length; i += this.BATCH_SIZE) {
        const batch = recordsToRetry.slice(i, i + this.BATCH_SIZE);
        await this.processBatch(batch);
        
        // Delay between batches to respect rate limits
        if (i + this.BATCH_SIZE < recordsToRetry.length) {
          logger.debug(`⏳ Waiting ${this.DELAY_BETWEEN_BATCHES/1000}s before next batch...`);
          await new Promise(resolve => setTimeout(resolve, this.DELAY_BETWEEN_BATCHES));
        }
      }

      logger.info('✅ Retry process completed');
    } catch (error) {
      logger.error('❌ Retry process failed', { error });
      throw error;
    }
  }

  // Get records that need retry (newer first, with empty predictions)
  private async getRecordsNeedingRetry(): Promise<RetryRecord[]> {
    try {
      const { data, error } = await supabaseService.getClient()
        .from('finfluencer_predictions')
        .select(`
          id,
          video_id,
          channel_id,
          video_title,
          retry_count,
          last_retry_at,
          retry_reason,
          post_date
        `)
        .eq('predictions', '[]')
        .or(`retry_count.is.null,retry_count.lt.${this.MAX_RETRY_ATTEMPTS}`)
        .order('post_date', { ascending: false }) // Newer first
        .limit(50); // Process maximum 50 records per run

      if (error) {
        throw new Error(`Failed to fetch retry candidates: ${error.message}`);
      }

      return data?.map(record => ({
        id: record.id,
        video_id: record.video_id,
        channel_id: record.channel_id,
        video_title: record.video_title,
        retry_count: record.retry_count || 0,
        last_retry_at: record.last_retry_at,
        retry_reason: record.retry_reason,
        post_date: record.post_date
      })) || [];
    } catch (error) {
      logger.error('Error fetching records for retry', { error });
      throw error;
    }
  }

  // Process a batch of records
  private async processBatch(records: RetryRecord[]): Promise<void> {
    logger.info(`🔄 Processing batch of ${records.length} records`);

    const promises = records.map(record => this.processSingleRecord(record));
    
    const results = await Promise.allSettled(promises);
    
    // Log results
    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.filter(r => r.status === 'rejected' || !r.value.success).length;
    
    logger.info(`📊 Batch results: ${successful} successful, ${failed} failed`);

    // Log individual failures for debugging
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(`Record ${records[index].video_id} failed completely`, { error: result.reason });
      } else if (!result.value.success) {
        logger.warn(`Record ${records[index].video_id} failed: ${result.value.error}`);
      }
    });
  }

  // Process a single record for retry
  private async processSingleRecord(record: RetryRecord): Promise<RetryResult> {
    const retryNumber = record.retry_count + 1;
    
    try {
      logger.info(`🔄 Retrying record ${record.video_id} (attempt ${retryNumber}/${this.MAX_RETRY_ATTEMPTS})`);

      // Get video info from RapidAPI /info endpoint
      const videoInfo = await rapidapiService.getVideoInfo(record.video_id);
      
      if (!videoInfo || !videoInfo.automatic_captions) {
        const error = 'No automatic captions available';
        await this.updateRetryStatus(record.id, retryNumber, error);
        logger.warn(`⚠️ ${error} for video ${record.video_id}`);
        return { success: false, transcriptFound: false, predictionsFound: 0, error };
      }

      // Find appropriate caption URL based on language
      const captionUrl = this.findCaptionUrl(videoInfo.automatic_captions, videoInfo.default_language);
      
      if (!captionUrl) {
        const error = 'No suitable caption URL found';
        await this.updateRetryStatus(record.id, retryNumber, error);
        logger.warn(`⚠️ ${error} for video ${record.video_id}`);
        return { success: false, transcriptFound: false, predictionsFound: 0, error };
      }

      logger.info(`✅ Found caption URL for video ${record.video_id}`);

      // Fetch transcript from caption URL
      const transcript = await this.fetchTranscriptFromCaptionUrl(captionUrl);
      
      if (!transcript || transcript.trim().length < 50) {
        const error = 'Transcript too short or empty';
        await this.updateRetryStatus(record.id, retryNumber, error);
        logger.warn(`⚠️ ${error} for video ${record.video_id}`);
        return { success: false, transcriptFound: false, predictionsFound: 0, error };
      }

      logger.info(`📝 Transcript found for video ${record.video_id} (${transcript.length} characters)`);

      // Analyze transcript with AI
      const analysis = await aiAnalyzer.analyzeTranscript(transcript, {
        videoId: record.video_id,
        title: record.video_title,
        channelId: record.channel_id,
        channelName: '', // We don't have this data here, but analyzer should handle it
        publishedAt: record.post_date
      });

      // Update the existing record with new results
      await supabaseService.updatePredictionWithRetry(record.id, {
        transcript_summary: analysis.transcript_summary,
        predictions: analysis.predictions,
        ai_modifications: analysis.ai_modifications,
        language: analysis.language
      });

      logger.info(`✅ Successfully updated predictions for video ${record.video_id}`, {
        predictionsFound: analysis.predictions.length,
        modifications: analysis.ai_modifications.length
      });

      // Mark as successful
      await this.markRetrySuccess(record.id);

      return {
        success: true,
        transcriptFound: true,
        predictionsFound: analysis.predictions.length
      };

    } catch (error) {
      const errorMessage = (error as Error).message;
      await this.updateRetryStatus(record.id, retryNumber, errorMessage);
      
      logger.error(`❌ Retry failed for video ${record.video_id}`, { error });
      
      return {
        success: false,
        transcriptFound: false,
        predictionsFound: 0,
        error: errorMessage
      };
    }
  }

  // Find the best caption URL from automatic_captions
  private findCaptionUrl(automaticCaptions: any, defaultLanguage?: string): string | null {
    try {
      // If default language is specified, try to find it first
      if (defaultLanguage && automaticCaptions[defaultLanguage]) {
        const langCaptions = automaticCaptions[defaultLanguage];
        const json3Format = langCaptions.find((caption: any) => caption.ext === 'json3');
        if (json3Format && json3Format.url) {
          return json3Format.url;
        }
      }

      // Fallback to English
      if (automaticCaptions.en) {
        const enCaptions = automaticCaptions.en;
        const json3Format = enCaptions.find((caption: any) => caption.ext === 'json3');
        if (json3Format && json3Format.url) {
          return json3Format.url;
        }
      }

      // Final fallback: use the first available language with json3 format
      for (const [lang, captions] of Object.entries(automaticCaptions)) {
        const langCaptions = captions as any[];
        const json3Format = langCaptions.find((caption: any) => caption.ext === 'json3');
        if (json3Format && json3Format.url) {
          logger.info(`Using caption URL from language: ${lang}`);
          return json3Format.url;
        }
      }

      return null;
    } catch (error) {
      logger.error('Error finding caption URL', { error });
      return null;
    }
  }

  // Fetch transcript from a caption URL
  private async fetchTranscriptFromCaptionUrl(captionUrl: string): Promise<string> {
    try {
      const response = await fetch(captionUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch caption URL: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      
      // Parse YouTube's JSON3 format for timed text
      if (data && data.events) {
        const transcript = data.events
          .filter((event: any) => event.segs) // Filter events with text segments
          .map((event: any) => 
            event.segs
              .filter((seg: any) => seg.utf8) // Filter segments with text
              .map((seg: any) => seg.utf8)
              .join('')
          )
          .join(' ')
          .trim();

        return transcript;
      }

      return '';
    } catch (error) {
      logger.error('Error fetching transcript from caption URL', { error, captionUrl });
      throw error;
    }
  }

  // Update retry status for a record
  private async updateRetryStatus(recordId: string, retryCount: number, reason: string): Promise<void> {
    try {
      await supabaseService.getClient()
        .from('finfluencer_predictions')
        .update({
          retry_count: retryCount,
          last_retry_at: new Date().toISOString(),
          retry_reason: reason
        })
        .eq('id', recordId);
    } catch (error) {
      logger.error('Error updating retry status', { recordId, error });
    }
  }

  // Mark a record as successfully retried
  private async markRetrySuccess(recordId: string): Promise<void> {
    try {
      await supabaseService.getClient()
        .from('finfluencer_predictions')
        .update({
          retry_count: this.MAX_RETRY_ATTEMPTS, // Set to max to prevent further retries
          last_retry_at: new Date().toISOString(),
          retry_reason: null // Clear any previous error
        })
        .eq('id', recordId);
    } catch (error) {
      logger.error('Error marking retry as successful', { recordId, error });
    }
  }

  // Get retry statistics
  async getRetryStatistics(): Promise<{
    totalEligible: number;
    maxAttemptsReached: number;
    lastRunResults?: any;
  }> {
    try {
      const { data, error } = await supabaseService.getClient()
        .from('finfluencer_predictions')
        .select('retry_count, last_retry_at')
        .eq('predictions', '[]');

      if (error) {
        throw error;
      }

      const totalEligible = data?.length || 0;
      const maxAttemptsReached = data?.filter(r => (r.retry_count || 0) >= this.MAX_RETRY_ATTEMPTS).length || 0;

      return {
        totalEligible,
        maxAttemptsReached
      };
    } catch (error) {
      logger.error('Error getting retry statistics', { error });
      return {
        totalEligible: 0,
        maxAttemptsReached: 0
      };
    }
  }
}

// Export singleton instance
export const retryService = new RetryService();
