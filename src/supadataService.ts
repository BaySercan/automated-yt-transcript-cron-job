import { config } from './config';
import { TranscriptError } from './errors';
import { 
  logger, 
  retryWithBackoff, 
  EnhancedRateLimiter, 
  CircuitBreaker,
  RateLimitMonitor,
  sleep 
} from './utils';

export interface SupadataTranscriptResponse {
  content: string;
  lang: string;
  availableLangs: string[];
  jobId?: string; // For async processing
}

export interface SupadataJobStatus {
  status: 'queued' | 'active' | 'completed' | 'failed';
  content?: string;
  error?: string;
  lang?: string;
  availableLangs?: string[];
}

export interface SupadataResult {
  content: string | null;
  error?: string;
  isAsync?: boolean;
  jobId?: string;
}

export class SupadataService {
  private readonly transcriptRateLimiter: EnhancedRateLimiter;
  private readonly resultRateLimiter: EnhancedRateLimiter;
  private readonly circuitBreaker: CircuitBreaker;
  private creditsUsed = 0;
  private lastCreditReset = new Date();

  constructor() {
    // Rate limiters for Supadata endpoints
    this.transcriptRateLimiter = new EnhancedRateLimiter(config.rateLimiting.supadataTranscriptRps);
    this.resultRateLimiter = new EnhancedRateLimiter(config.rateLimiting.supadataResultRps);
    
    // Circuit breaker for overall API protection
    this.circuitBreaker = new CircuitBreaker(5, 180000); // 5 failures, 3 minute reset timeout
  }

  // Test Supadata connection
  async testConnection(): Promise<boolean> {
    if (!config.supadataApiKey || config.supadataApiKey.length < 10) {
      logger.warn('Supadata API key not configured or invalid');
      return false;
    }

    try {
      // Test with a simple request using a known video
      const testUrl = encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      const response = await this.fetchTranscript(testUrl, 'native');
      
      if (response.content || response.isAsync) {
        logger.info('Supadata connection successful');
        return true;
      }
      
      return false;
    } catch (error) {
      logger.warn('Supadata connection test failed', { error });
      return false;
    }
  }

  // Get video transcript with credit optimization
  async getVideoTranscript(videoId: string): Promise<string> {
    if (!config.supadataApiKey || config.supadataApiKey.length < 10) {
      throw new TranscriptError('Supadata API key not configured');
    }

    const videoUrl = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const startTime = Date.now();

    try {
      logger.info(`Requesting transcript from Supadata for video ${videoId}`);
      
      // Reset monthly credits if needed
      this.resetMonthlyCredits();
      
      return await this.circuitBreaker.execute(async () => {
        // First attempt: Native mode (1 credit) - tries existing transcripts only
        let result = await this.fetchTranscript(videoUrl, 'native');
        
        if (result.content) {
          this.creditsUsed += 1;
          logger.info(`✅ Supadata native transcript successful for ${videoId} (1 credit used, total: ${this.creditsUsed})`);
          return result.content;
        }

        // Second attempt: Auto mode (1-2 credits) - tries native, falls back to generate
        logger.info(`Trying Supadata auto mode for ${videoId} (1-2 credits)`);
        result = await this.fetchTranscript(videoUrl, 'auto');
        
        if (result.content) {
          // Estimate credits: 1 for native success, 2 for generated transcript
          this.creditsUsed += result.content.length < 100 ? 1 : 2; // Rough estimate based on transcript length
          logger.info(`✅ Supadata auto transcript successful for ${videoId} (${result.content.length < 100 ? 1 : 2} credits used, total: ${this.creditsUsed})`);
          return result.content;
        }

        // Third attempt: Generate mode (2 credits) - always uses AI
        logger.info(`Trying Supadata generate mode for ${videoId} (2 credits)`);
        result = await this.fetchTranscript(videoUrl, 'generate');
        
        if (result.content) {
          this.creditsUsed += 2;
          logger.info(`✅ Supadata generated transcript successful for ${videoId} (2 credits used, total: ${this.creditsUsed})`);
          return result.content;
        }

        // All attempts failed
        throw new TranscriptError('All Supadata transcript attempts failed');
      });
      
    } catch (error) {
      const totalTime = Date.now() - startTime;
      const isCreditError = (error as Error).message.includes('insufficient') || 
                           (error as Error).message.includes('credit');
      
      logger.error(`Supadata transcript fetch failed for video ${videoId}`, { 
        error, 
        totalTime,
        isCreditError 
      });
      
      // Record error metrics
      RateLimitMonitor.recordRequest('supadata-transcript', false, totalTime, isCreditError);
      
      if (isCreditError) {
        throw new TranscriptError(`Insufficient Supadata credits: ${(error as Error).message}`);
      }
      
      throw new TranscriptError(`Supadata failed: ${(error as Error).message}`);
    }
  }

  // Fetch transcript with specific mode
  private async fetchTranscript(url: string, mode: 'native' | 'auto' | 'generate'): Promise<SupadataResult> {
    const startTime = Date.now();
    
    try {
      // Apply rate limiting
      await this.transcriptRateLimiter.wait();
      
      // Choose endpoint based on available URLs
      const endpoint = this.getActiveEndpoint();
      const urlWithParams = `${endpoint}/transcript?url=${url}&text=true&mode=${mode}`;
      
      const response = await fetch(urlWithParams, {
        method: 'GET',
        headers: {
          'x-api-key': config.supadataApiKey,
          'Content-Type': 'application/json'
        }
      });

      const responseTime = Date.now() - startTime;

      // Handle 429 errors
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '60');
        logger.warn(`Supadata rate limit hit: ${retryAfter}s until reset`);
        
        RateLimitMonitor.recordRequest('supadata-transcript', false, responseTime, true);
        await this.transcriptRateLimiter.handle429Error();
        throw new TranscriptError(`Rate limited: retry after ${retryAfter} seconds`);
      }

      if (!response.ok) {
        const errorMsg = `Supadata API failed: HTTP ${response.status} ${response.statusText}`;
        logger.error(errorMsg, { url: urlWithParams });
        
        RateLimitMonitor.recordRequest('supadata-transcript', false, responseTime, response.status === 429);
        throw new TranscriptError(errorMsg);
      }

      const data = await response.json() as any;
      
      // Check for async processing (HTTP 202)
      if (data.jobId) {
        logger.info(`Supadata async processing started: ${data.jobId}`);
        return await this.pollForJobResult(data.jobId);
      }
      
      // Check for direct content
      if (data.content && data.content.trim().length > 0) {
        RateLimitMonitor.recordRequest('supadata-transcript', true, responseTime);
        return {
          content: data.content,
          isAsync: false
        };
      }
      
      // No content available
      RateLimitMonitor.recordRequest('supadata-transcript', false, responseTime);
      return {
        content: null,
        error: 'No transcript content available'
      };
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const isRateLimitError = (error as Error).message.includes('Rate limited') || 
                              (error as Error).message.includes('429');
      
      logger.error(`Supadata transcript request failed`, { error, responseTime, isRateLimitError });
      RateLimitMonitor.recordRequest('supadata-transcript', false, responseTime, isRateLimitError);
      
      return {
        content: null,
        error: (error as Error).message
      };
    }
  }

  // Poll for async job result
  private async pollForJobResult(jobId: string): Promise<SupadataResult> {
    const startTime = Date.now();
    const maxPollTime = config.supadataMaxPollTime;
    const maxAttempts = Math.floor(maxPollTime / config.supadataPollInterval);
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        // Apply rate limiting
        await this.resultRateLimiter.wait();
        
        const endpoint = this.getActiveEndpoint();
        const response = await fetch(`${endpoint}/transcript/${jobId}`, {
          method: 'GET',
          headers: {
            'x-api-key': config.supadataApiKey,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          const errorMsg = `Supadata job status failed: HTTP ${response.status}`;
          logger.error(errorMsg);
          throw new TranscriptError(errorMsg);
        }

        const jobData = await response.json() as SupadataJobStatus;
        
        logger.info(`🔍 Supadata job polling ${attempts + 1}/${maxAttempts}:`, {
          jobId,
          status: jobData.status,
          hasContent: !!jobData.content
        });
        
        // Check for completion
        if (jobData.status === 'completed' && jobData.content) {
          const totalTime = Date.now() - startTime;
          logger.info(`🎉 Supadata job completed: ${jobId} after ${attempts + 1} attempts (${totalTime/1000}s)`);
          
          RateLimitMonitor.recordRequest('supadata-polling', true, totalTime);
          return {
            content: jobData.content,
            isAsync: true,
            jobId
          };
        }
        
        // Check for failure
        if (jobData.status === 'failed') {
          const error = `Supadata job failed: ${jobData.error || 'Unknown error'}`;
          logger.error(`❌ FAILED! ${error}`, { jobId, jobData });
          
          RateLimitMonitor.recordRequest('supadata-polling', false, Date.now() - startTime);
          return {
            content: null,
            error
          };
        }
        
        // Still processing
        const pollDelay = config.supadataPollInterval;
        logger.info(`⏳ Supadata job still processing: ${jobId} - Attempt ${attempts + 1}/${maxAttempts}, Next poll in ${pollDelay/1000}s`);
        
        await new Promise(resolve => setTimeout(resolve, pollDelay));
        
      } catch (error) {
        const pollDelay = config.supadataPollInterval;
        const isRateLimitError = (error as Error).message.includes('429') ||
                                (error as Error).message.includes('rate limit');
        
        logger.warn(`Error polling Supadata job ${jobId} (attempt ${attempts + 1}/${maxAttempts})`, { 
          error,
          isRateLimitError
        });
        
        if (isRateLimitError) {
          await this.resultRateLimiter.handle429Error();
        } else {
          logger.info(`Retrying in ${pollDelay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, pollDelay));
        }
        
        RateLimitMonitor.recordRequest('supadata-polling', false, Date.now() - startTime, isRateLimitError);
      }
      
      attempts++;
    }
    
    throw new TranscriptError(`Supadata job timeout after ${maxAttempts} attempts (${Math.round((Date.now() - startTime) / 1000)}s) for job ${jobId}`);
  }

  // Get active endpoint (main Supadata or RapidAPI version)
  private getActiveEndpoint(): string {
    // Check if we should switch to RapidAPI version due to low credits
    if (config.credits.switchPlatform && this.creditsUsed > (100 - config.supadataCreditsThreshold)) {
      if (config.rapidapiSupadataUrl) {
        logger.warn(`Switching to Supadata RapidAPI endpoint due to low credits (used: ${this.creditsUsed})`);
        return config.rapidapiSupadataUrl;
      }
    }
    
    return config.supadataUrl;
  }

  // Reset monthly credits
  private resetMonthlyCredits(): void {
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    if (this.lastCreditReset < firstDayOfMonth) {
      logger.info('🔄 Monthly Supadata credit reset - starting fresh for new billing cycle');
      this.creditsUsed = 0;
      this.lastCreditReset = now;
    }
  }

  // Check if Supadata is properly configured
  isConfigured(): boolean {
    const hasMainConfig = config.supadataApiKey && config.supadataApiKey.length > 10;
    const hasRapidAPIConfig = config.rapidapiSupadataUrl && config.rapidapiSupadataUrl.length > 10;
    return hasMainConfig || hasRapidAPIConfig;
  }

  // Get credit usage statistics
  getCreditStats(): any {
    return {
      creditsUsed: this.creditsUsed,
      creditsRemaining: 100 - this.creditsUsed,
      lastReset: this.lastCreditReset,
      activeEndpoint: this.getActiveEndpoint(),
      circuitBreaker: this.circuitBreaker.getStatus(),
      endpointStats: {
        transcript: RateLimitMonitor.getStats('supadata-transcript'),
        polling: RateLimitMonitor.getStats('supadata-polling')
      }
    };
  }

  // Reset credit usage (for testing or manual reset)
  resetCredits(): void {
    this.creditsUsed = 0;
    this.lastCreditReset = new Date();
    logger.info('📊 Supadata credit usage reset');
  }

  // Get current rate limiting statistics
  getRateLimitStats(): any {
    return {
      circuitBreaker: this.circuitBreaker.getStatus(),
      endpointStats: {
        transcript: RateLimitMonitor.getStats('supadata-transcript'),
        polling: RateLimitMonitor.getStats('supadata-polling')
      }
    };
  }

  // Reset rate limiting metrics
  resetMetrics(): void {
    ['supadata-transcript', 'supadata-polling']
      .forEach(endpoint => RateLimitMonitor.reset(endpoint));
    logger.info('📊 Supadata rate limiting metrics reset');
  }
}

// Export singleton instance
export const supadataService = new SupadataService();
