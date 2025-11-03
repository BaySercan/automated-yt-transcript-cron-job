import { supabaseService } from './supabase';
import { rapidapiService } from './rapidapi';
import { aiAnalyzer } from './analyzer';
import { 
  logger, 
  retryWithBackoff, 
  isValidYouTubeVideoId,
  EnhancedRateLimiter,
  CircuitBreaker,
  RateLimitMonitor,
  sleep
} from './utils';
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
  private readonly BATCH_SIZE = 5; // Reduced from 10 to 5
  private readonly DELAY_BETWEEN_BATCHES = 12000; // Increased from 5s to 12s
  private readonly SEQUENTIAL_DELAY = 3000; // 3 seconds between individual records
  private readonly MAX_429_RETRIES = 3;
  
  // Enhanced rate limiting infrastructure
  private readonly rateLimiter: EnhancedRateLimiter;
  private readonly circuitBreaker: CircuitBreaker;

  constructor() {
    // Rate limit to respect RapidAPI limits - more conservative
    this.rateLimiter = new EnhancedRateLimiter(0.5); // 1 request per 2 seconds
    // Circuit breaker with threshold for failures
    this.circuitBreaker = new CircuitBreaker(5, 60000); // 5 failures, 1 minute reset
  }

  // Main method to process all failed predictions
  async processFailedPredictions(): Promise<void> {
    try {
      logger.info('🔄 Starting retry process for failed predictions with enhanced rate limiting');

      // Get records that need retry (newer first)
      const recordsToRetry = await this.getRecordsNeedingRetry();
      
      if (recordsToRetry.length === 0) {
        logger.info('✅ No records found that need retry');
        return;
      }

      logger.info(`📋 Found ${recordsToRetry.length} records to retry`);
      logger.info(`⚙️ Batch size: ${this.BATCH_SIZE}, Delay between batches: ${this.DELAY_BETWEEN_BATCHES/1000}s`);

      // Process in smaller batches with enhanced rate limiting
      for (let i = 0; i < recordsToRetry.length; i += this.BATCH_SIZE) {
        const batch = recordsToRetry.slice(i, i + this.BATCH_SIZE);
        await this.processBatchWithRateLimit(batch);
        
        // Enhanced delay between batches with jitter
        if (i + this.BATCH_SIZE < recordsToRetry.length) {
          const jitter = Math.random() * 2000; // Add up to 2s jitter
          const finalDelay = this.DELAY_BETWEEN_BATCHES + jitter;
          
          logger.debug(`⏳ Waiting ${(finalDelay/1000).toFixed(1)}s before next batch...`);
          await new Promise(resolve => setTimeout(resolve, finalDelay));
        }
      }

      // Log final statistics
      const stats = RateLimitMonitor.getStats('retry-service');
      logger.info('✅ Retry process completed', {
        totalRecordsProcessed: recordsToRetry.length,
        rateLimitStats: stats
      });
      
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
        .limit(30); // Reduced from 50 to 30 per run for better rate limiting

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

  // Process a batch with enhanced rate limiting and circuit breaker
  private async processBatchWithRateLimit(records: RetryRecord[]): Promise<void> {
    logger.info(`🔄 Processing batch of ${records.length} records with rate limiting`);

    // Use circuit breaker to protect against repeated failures
    await this.circuitBreaker.execute(async () => {
      // Process records sequentially within batch to reduce load
      const results: RetryResult[] = [];
      
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        
        try {
          logger.debug(`Processing record ${i + 1}/${records.length}: ${record.video_id}`);
          
          // Apply rate limiting before each record
          await this.rateLimiter.wait();
          
          const result = await this.processSingleRecordWith429Handling(record);
          results.push(result);
          
          // Add small delay between individual records for better rate limiting
          if (i < records.length - 1) {
            await sleep(this.SEQUENTIAL_DELAY);
          }
          
        } catch (error) {
          logger.error(`Failed to process record ${record.video_id}`, { error });
          results.push({
            success: false,
            transcriptFound: false,
            predictionsFound: 0,
            error: (error as Error).message
          });
        }
      }
      
      // Log batch results with rate limit statistics
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      const rateLimitErrors = results.filter(r => r.error?.includes('429') || r.error?.includes('rate limit')).length;
      
      logger.info(`📊 Batch completed: ${successful} successful, ${failed} failed, ${rateLimitErrors} rate-limited`);
      
      // Record batch statistics
      RateLimitMonitor.recordRequest('retry-batch', successful > 0, Date.now(), rateLimitErrors > 0);
      
      if (rateLimitErrors > 0) {
        logger.warn(`⚠️ ${rateLimitErrors} rate limit errors in batch - consider reducing batch size`);
      }
    });
  }

  // Process a single record with 429-specific error handling
  private async processSingleRecordWith429Handling(record: RetryRecord): Promise<RetryResult> {
    const retryNumber = record.retry_count + 1;
    let attempt = 0;
    
    while (attempt <= this.MAX_429_RETRIES) {
      try {
        return await this.processSingleRecord(record);
      } catch (error) {
        const errorMessage = (error as Error).message;
        const isRateLimitError = errorMessage.includes('429') || 
                                errorMessage.includes('rate limit') ||
                                errorMessage.includes('too many requests');
        
        if (isRateLimitError && attempt < this.MAX_429_RETRIES) {
          attempt++;
          logger.warn(`⚠️ Rate limit hit for ${record.video_id}, retrying with backoff (attempt ${attempt}/${this.MAX_429_RETRIES})`);
          await this.rateLimiter.handle429Error(attempt);
          continue;
        }
        
        // Non-rate-limit error or max retries reached
        await this.updateRetryStatus(record.id, retryNumber, errorMessage);
        logger.error(`❌ Retry failed for video ${record.video_id}`, { 
          error, 
          attempt: attempt + 1,
          isRateLimitError 
        });
        
        return {
          success: false,
          transcriptFound: false,
          predictionsFound: 0,
          error: errorMessage
        };
      }
    }
    
    // Should not reach here, but just in case
    return {
      success: false,
      transcriptFound: false,
      predictionsFound: 0,
      error: 'Max 429 retries exceeded'
    };
  }

  // Process a single record for retry
  private async processSingleRecord(record: RetryRecord): Promise<RetryResult> {
    const retryNumber = record.retry_count + 1;
    const startTime = Date.now();
    
    try {
      logger.info(`🔄 Retrying record ${record.video_id} (attempt ${retryNumber}/${this.MAX_RETRY_ATTEMPTS})`);

      // Apply rate limiting before API calls
      await this.rateLimiter.wait();

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
        modifications: analysis.ai_modifications.length,
        processingTime: Date.now() - startTime
      });

      // Mark as successful
      await this.markRetrySuccess(record.id);

      // Record successful metrics
      RateLimitMonitor.recordRequest('retry-record', true, Date.now() - startTime);

      return {
        success: true,
        transcriptFound: true,
        predictionsFound: analysis.predictions.length
      };

    } catch (error) {
      const errorMessage = (error as Error).message;
      await this.updateRetryStatus(record.id, retryNumber, errorMessage);
      
      const isRateLimitError = errorMessage.includes('429') || 
                              errorMessage.includes('rate limit') ||
                              errorMessage.includes('too many requests');
      
      logger.error(`❌ Retry failed for video ${record.video_id}`, { 
        error,
        processingTime: Date.now() - startTime,
        isRateLimitError
      });
      
      // Record failed metrics
      RateLimitMonitor.recordRequest('retry-record', false, Date.now() - startTime, isRateLimitError);
      
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

  // Get retry statistics including rate limit metrics
  async getRetryStatistics(): Promise<{
    totalEligible: number;
    maxAttemptsReached: number;
    rateLimitStats?: any;
    circuitBreakerStatus?: any;
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
        maxAttemptsReached,
        rateLimitStats: RateLimitMonitor.getStats('retry-service'),
        circuitBreakerStatus: this.circuitBreaker.getStatus()
      };
    } catch (error) {
      logger.error('Error getting retry statistics', { error });
      return {
        totalEligible: 0,
        maxAttemptsReached: 0,
        rateLimitStats: null,
        circuitBreakerStatus: this.circuitBreaker.getStatus()
      };
    }
  }

  // Reset rate limiting metrics (for testing or manual reset)
  async resetMetrics(): Promise<void> {
    try {
      RateLimitMonitor.reset('retry-service');
      RateLimitMonitor.reset('retry-batch');
      RateLimitMonitor.reset('retry-record');
      logger.info('📊 Rate limiting metrics reset');
    } catch (error) {
      logger.error('Error resetting metrics', { error });
    }
  }
}

// Export singleton instance
export const retryService = new RetryService();
