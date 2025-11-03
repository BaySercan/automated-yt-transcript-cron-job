import { config } from './config';
import { RapidAPITranscriptResponse, RapidAPIResult } from './types';
import { TranscriptError } from './errors';
import { 
  logger, 
  retryWithBackoff, 
  EnhancedRateLimiter, 
  CircuitBreaker,
  RateLimitMonitor,
  sleep 
} from './utils';

export interface VideoInfo {
  automatic_captions?: any;
  default_language?: string;
  [key: string]: any;
}

export class RapidAPIService {
  // Enhanced rate limiting infrastructure
  private readonly infoRateLimiter: EnhancedRateLimiter;
  private readonly transcriptRateLimiter: EnhancedRateLimiter;
  private readonly resultRateLimiter: EnhancedRateLimiter;
  private readonly circuitBreaker: CircuitBreaker;

  constructor() {
    // Separate rate limiters for different endpoints with conservative limits
    this.infoRateLimiter = new EnhancedRateLimiter(0.7); // 1 request per ~1.4 seconds for info endpoint
    this.transcriptRateLimiter = new EnhancedRateLimiter(0.5); // 1 request per 2 seconds for transcript endpoint
    this.resultRateLimiter = new EnhancedRateLimiter(1.0); // 1 request per second for result endpoint
    
    // Circuit breaker for overall API protection
    this.circuitBreaker = new CircuitBreaker(8, 120000); // 8 failures, 2 minute reset timeout
  }

  // Test RapidAPI connection
  async testConnection(): Promise<boolean> {
    if (!config.rapidapiKey || config.rapidapiKey.length < 10) {
      logger.warn('RapidAPI key not configured or invalid');
      return false;
    }

    try {
      // Test with a simple request (we'll use a known video ID for testing)
      const testVideoId = 'dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up
      const response = await this.requestTranscript(testVideoId);
      
      if (response.process_id) {
        logger.info('RapidAPI connection successful');
        return true;
      }
      
      return false;
    } catch (error) {
      logger.warn('RapidAPI connection test failed', { error });
      return false;
    }
  }

  // Get video info including automatic_captions from /info endpoint
  async getVideoInfo(videoId: string): Promise<VideoInfo | null> {
    if (!config.rapidapiKey || config.rapidapiKey.length < 10) {
      throw new TranscriptError('RapidAPI key not configured');
    }

    if (!videoId || !videoId.trim()) {
      throw new TranscriptError('Invalid video ID');
    }

    const startTime = Date.now();

    try {
      logger.info(`Fetching video info from RapidAPI /info endpoint for video ${videoId}`);
      
      // Use circuit breaker and rate limiter
      return await this.circuitBreaker.execute(async () => {
        // Apply rate limiting for info endpoint
        await this.infoRateLimiter.wait();
        
        const url = `${config.rapidapiUrl}/info?url=https://www.youtube.com/watch?v=${videoId}`;
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'X-RapidAPI-Host': config.rapidapiHost,
            'X-RapidAPI-Key': config.rapidapiKey,
            'Content-Type': 'application/json'
          }
        });

        const responseTime = Date.now() - startTime;

        // Handle 429 rate limit errors specially
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '60');
          logger.warn(`Rate limit hit for video info request: ${retryAfter}s until reset`);
          
          // Record rate limit violation
          RateLimitMonitor.recordRequest('rapidapi-info', false, responseTime, true);
          
          // Use enhanced rate limiter's 429 handling
          await this.infoRateLimiter.handle429Error();
          throw new TranscriptError(`Rate limited: retry after ${retryAfter} seconds`);
        }

        if (!response.ok) {
          const errorMsg = `RapidAPI /info endpoint failed: HTTP ${response.status} ${response.statusText}`;
          logger.error(errorMsg, { url: url.replace(/key=[^&]*/, 'key=REDACTED') });
          
          RateLimitMonitor.recordRequest('rapidapi-info', false, responseTime, response.status === 429);
          throw new TranscriptError(errorMsg);
        }

        const data = await response.json() as VideoInfo;
        
        // Log some info about what we received
        logger.info(`📋 Received video info for ${videoId}:`, {
          hasAutomaticCaptions: !!data.automatic_captions,
          defaultLanguage: data.language,
          availableFields: Object.keys(data).filter(key => !key.startsWith('_'))
        });

        // Record successful metrics
        RateLimitMonitor.recordRequest('rapidapi-info', true, responseTime);

        return data;
      });
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const isRateLimitError = (error as Error).message.includes('Rate limited') || 
                              (error as Error).message.includes('429');
      
      logger.error(`RapidAPI /info endpoint failed for video ${videoId}`, { 
        error, 
        responseTime,
        isRateLimitError 
      });
      
      throw new TranscriptError(`RapidAPI /info failed: ${(error as Error).message}`);
    }
  }

  // Get transcript using RapidAPI (two-step process)
  async getVideoTranscript(videoId: string): Promise<string> {
    if (!config.rapidapiKey || config.rapidapiKey.length < 10) {
      throw new TranscriptError('RapidAPI key not configured');
    }

    const startTime = Date.now();

    try {
      logger.info(`Requesting transcript from RapidAPI for video ${videoId}`);
      
      // Use circuit breaker protection
      return await this.circuitBreaker.execute(async () => {
        // Step 1: Request transcript processing with rate limiting
        const initialResponse = await this.requestTranscript(videoId);
        
        if (!initialResponse.process_id) {
          throw new TranscriptError('No process ID returned from RapidAPI');
        }

        logger.info(`RapidAPI process started with ID: ${initialResponse.process_id}`);

        // Step 2: Poll for results with rate limiting
        const result = await this.pollForResult(initialResponse.process_id);
        
        // 🔍 CRITICAL FIX: Handle the result from polling using the NEW format
        logger.info(`🔍 POLLING RESULT DEBUG for ${videoId}:`, {
          success: result.success,
          isProcessed: result.isProcessed,
          hasTranscript: !!result.transcript,
          transcriptLength: result.transcript?.length || 0,
          status: result.status
        });
        
        // Check for successful completion using NEW format
        if (result.success === true && result.transcript && result.transcript.trim().length > 0) {
          const totalTime = Date.now() - startTime;
          logger.info(`✅ SUCCESS! Transcript ready for video ${videoId} (${result.transcript.length} characters)`);
          
          // Record successful metrics
          RateLimitMonitor.recordRequest('rapidapi-transcript', true, totalTime);
          
          return result.transcript;
        }

        // Check for processing failure using NEW format
        if (result.success === false || (result.isProcessed === true && !result.transcript) || result.status === 'failed') {
          const error = `RapidAPI processing failed: ${result.error || 'Unknown processing error'}`;
          logger.error(`❌ FAILED! ${error}`, { result });
          
          // Record failed metrics
          RateLimitMonitor.recordRequest('rapidapi-transcript', false, Date.now() - startTime);
          
          throw new TranscriptError(error);
        }

        // If we get here, something unexpected happened
        const errorMsg = 'Unexpected polling result format';
        logger.error(`❌ UNEXPECTED! ${errorMsg}`, { result });
        
        // Record failed metrics
        RateLimitMonitor.recordRequest('rapidapi-transcript', false, Date.now() - startTime);
        
        throw new TranscriptError(errorMsg);
      });
      
    } catch (error) {
      const totalTime = Date.now() - startTime;
      const isRateLimitError = (error as Error).message.includes('Rate limited') || 
                              (error as Error).message.includes('429') ||
                              (error as Error).message.includes('too many requests');
      
      logger.error(`RapidAPI transcript fetch failed for video ${videoId}`, { 
        error, 
        totalTime,
        isRateLimitError 
      });
      
      // Record error metrics
      RateLimitMonitor.recordRequest('rapidapi-transcript', false, totalTime, isRateLimitError);
      
      throw new TranscriptError(`RapidAPI failed: ${(error as Error).message}`);
    }
  }

  // Step 1: Request transcript processing
  private async requestTranscript(videoId: string): Promise<RapidAPITranscriptResponse> {
    const startTime = Date.now();
    
    try {
      // Apply rate limiting for transcript requests
      await this.transcriptRateLimiter.wait();

      const url = `${config.rapidapiUrl}/transcript?skipAI=false&url=https://www.youtube.com/watch?v=${videoId}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-RapidAPI-Host': config.rapidapiHost,
          'X-RapidAPI-Key': config.rapidapiKey,
          'Content-Type': 'application/json'
        }
      });

      const responseTime = Date.now() - startTime;

      // Handle 429 errors specially
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '60');
        logger.warn(`Rate limit hit for transcript request: ${retryAfter}s until reset`);
        
        RateLimitMonitor.recordRequest('rapidapi-transcript-request', false, responseTime, true);
        
        // Use enhanced rate limiter's 429 handling
        await this.transcriptRateLimiter.handle429Error();
        throw new TranscriptError(`Rate limited: retry after ${retryAfter} seconds`);
      }

      if (!response.ok) {
        const errorMsg = `RapidAPI request failed: HTTP ${response.status} ${response.statusText}`;
        logger.error(errorMsg, { url: url.replace(/key=[^&]*/, 'key=REDACTED') });
        
        RateLimitMonitor.recordRequest('rapidapi-transcript-request', false, responseTime, response.status === 429);
        throw new TranscriptError(errorMsg);
      }

      const data = await response.json() as any;
      
      // Handle both possible field names: process_id or processingId
      const processId = data.process_id || data.processingId;
      
      if (!processId) {
        throw new TranscriptError('Invalid response from RapidAPI: missing process_id/processingId');
      }

      // Record successful metrics
      RateLimitMonitor.recordRequest('rapidapi-transcript-request', true, responseTime);

      return {
        process_id: processId,
        status: data.status || 'processing'
      } as RapidAPITranscriptResponse;
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const isRateLimitError = (error as Error).message.includes('Rate limited') || 
                              (error as Error).message.includes('429');
      
      logger.error(`Transcript request failed for ${videoId}`, { error, responseTime, isRateLimitError });
      
      RateLimitMonitor.recordRequest('rapidapi-transcript-request', false, responseTime, isRateLimitError);
      
      throw error;
    }
  }

  // Step 2: Poll for processing results with adaptive timing
  private async pollForResult(processId: string): Promise<RapidAPIResult> {
    const startTime = Date.now();
    const maxPollTime = 25 * 60 * 1000; // 25 minutes maximum
    const maxAttempts = 40; // More attempts with adaptive intervals
    let attempts = 0;
    
    // Adaptive polling: start fast, slow down over time
    const getPollDelay = (attempt: number): number => {
      if (attempt < 5) return 30000; // First 5 attempts: 30 seconds
      if (attempt < 10) return 45000; // Next 5 attempts: 45 seconds
      if (attempt < 20) return 60000; // Next 10 attempts: 60 seconds
      return 90000; // After that: 90 seconds
    };
    
    while (attempts < maxAttempts) {
      // Check if we've exceeded maximum poll time
      if (Date.now() - startTime > maxPollTime) {
        throw new TranscriptError(`RapidAPI processing timeout after ${maxPollTime/1000/60} minutes for process ${processId}`);
      }
      
      try {
        // Apply rate limiting for result polling
        await this.resultRateLimiter.wait();
        
        const result = await this.getResult(processId);
        
        // 🔍 DETAILED DEBUG LOGGING
        logger.info(`🔍 RAPIDAPI POLLING ATTEMPT ${attempts + 1}/${maxAttempts} for ${processId}:`, {
          success: result.success,
          isProcessed: result.isProcessed,
          hasTranscript: !!result.transcript,
          transcriptLength: result.transcript?.length || 0,
          status: result.status,
          allFields: Object.keys(result)
        });
        
        // Check for successful completion - RapidAPI returns success: true when done
        if (result.success === true && result.transcript && result.transcript.trim().length > 0) {
          const totalTime = Date.now() - startTime;
          logger.info(`🎉 SUCCESS! RapidAPI processing completed for ${processId} after ${attempts + 1} attempts (${totalTime/1000}s)`);
          logger.info(`📝 Transcript found: ${result.transcript.length} characters`);
          logger.info(`📄 Transcript preview: "${result.transcript.substring(0, 200)}..."`);
          
          // Record successful metrics
          RateLimitMonitor.recordRequest('rapidapi-polling', true, Date.now() - startTime);
          
          return result;
        }
        
        // Check for processing failure - RapidAPI returns success: false when failed OR status: "failed"
        if (result.success === false || (result.isProcessed === true && !result.transcript) || result.status === 'failed') {
          logger.error(`❌ FAILED! RapidAPI processing failed for ${processId}`, { 
            success: result.success,
            isProcessed: result.isProcessed,
            hasTranscript: !!result.transcript,
            status: result.status,
            fullResult: result 
          });
          
          // Record failed metrics
          RateLimitMonitor.recordRequest('rapidapi-polling', false, Date.now() - startTime);
          
          return result;
        }
        
        // Still processing (isProcessed: false), log progress and wait
        const progress = (result as any).progress || (result as any).percentage || 'unknown';
        const pollDelay = getPollDelay(attempts);
        
        logger.info(`⏳ STILL PROCESSING: ${processId} - Attempt ${attempts + 1}/${maxAttempts}, Progress: ${progress}%, Next poll in ${pollDelay/1000}s`);
        
        await new Promise(resolve => setTimeout(resolve, pollDelay));
        
      } catch (error) {
        const pollDelay = getPollDelay(attempts);
        const isRateLimitError = (error as Error).message.includes('429') ||
                                (error as Error).message.includes('rate limit');
        
        logger.warn(`Error polling RapidAPI result for ${processId} (attempt ${attempts + 1}/${maxAttempts})`, { 
          error,
          isRateLimitError
        });
        
        // If it's a rate limit error, use enhanced rate limiter's handling
        if (isRateLimitError) {
          await this.resultRateLimiter.handle429Error();
        } else {
          logger.info(`Retrying in ${pollDelay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, pollDelay));
        }
        
        // Record error metrics
        RateLimitMonitor.recordRequest('rapidapi-polling', false, Date.now() - startTime, isRateLimitError);
      }
      
      attempts++;
    }
    
    throw new TranscriptError(`RapidAPI processing timeout after ${maxAttempts} attempts (${Math.round((Date.now() - startTime) / 1000)}s) for process ${processId}`);
  }

  // Get processing result by process ID
  private async getResult(processId: string): Promise<RapidAPIResult> {
    const startTime = Date.now();
    
    try {
      const url = `${config.rapidapiUrl}/result/${processId}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-RapidAPI-Host': config.rapidapiHost,
          'X-RapidAPI-Key': config.rapidapiKey,
          'Content-Type': 'application/json'
        }
      });

      const responseTime = Date.now() - startTime;

      // Handle 429 errors specially
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '60');
        logger.warn(`Rate limit hit for result request: ${retryAfter}s until reset`);
        
        RateLimitMonitor.recordRequest('rapidapi-result', false, responseTime, true);
        
        // Use enhanced rate limiter's 429 handling
        await this.resultRateLimiter.handle429Error();
        throw new TranscriptError(`Rate limited: retry after ${retryAfter} seconds`);
      }

      if (!response.ok) {
        const errorMsg = `RapidAPI result request failed: HTTP ${response.status} ${response.statusText}`;
        logger.error(errorMsg, { url: url.replace(/key=[^&]*/, 'key=REDACTED') });
        
        RateLimitMonitor.recordRequest('rapidapi-result', false, responseTime, response.status === 429);
        throw new TranscriptError(errorMsg);
      }

      const data = await response.json() as any;
      
      // Enhanced validation for new response format
      if (!data.success && !data.isProcessed && !data.status) {
        throw new TranscriptError('Invalid response from RapidAPI: missing required fields');
      }

      // Record successful metrics
      RateLimitMonitor.recordRequest('rapidapi-result', true, responseTime);

      return data as RapidAPIResult;
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const isRateLimitError = (error as Error).message.includes('Rate limited') || 
                              (error as Error).message.includes('429');
      
      logger.error(`Result request failed for process ${processId}`, { error, responseTime, isRateLimitError });
      
      RateLimitMonitor.recordRequest('rapidapi-result', false, responseTime, isRateLimitError);
      
      throw error;
    }
  }

  // Check if RapidAPI is properly configured
  isConfigured(): boolean {
    return !!(config.rapidapiKey && config.rapidapiKey.length > 10 && config.rapidapiHost && config.rapidapiUrl);
  }

  // Get current rate limiting statistics
  getRateLimitStats(): any {
    return {
      circuitBreaker: this.circuitBreaker.getStatus(),
      endpointStats: {
        info: RateLimitMonitor.getStats('rapidapi-info'),
        transcript: RateLimitMonitor.getStats('rapidapi-transcript'),
        transcriptRequest: RateLimitMonitor.getStats('rapidapi-transcript-request'),
        polling: RateLimitMonitor.getStats('rapidapi-polling'),
        result: RateLimitMonitor.getStats('rapidapi-result')
      }
    };
  }

  // Reset rate limiting metrics (for testing or manual reset)
  resetMetrics(): void {
    ['rapidapi-info', 'rapidapi-transcript', 'rapidapi-transcript-request', 'rapidapi-polling', 'rapidapi-result']
      .forEach(endpoint => RateLimitMonitor.reset(endpoint));
    logger.info('📊 RapidAPI rate limiting metrics reset');
  }
}

// Export singleton instance
export const rapidapiService = new RapidAPIService();
