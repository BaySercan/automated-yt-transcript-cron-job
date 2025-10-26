import { config } from './config';
import { RapidAPITranscriptResponse, RapidAPIResult } from './types';
import { TranscriptError } from './errors';
import { logger, retryWithBackoff, RateLimiter, TranscriptLogger, TranscriptMetrics } from './utils';

export class RapidAPIService {
  private rateLimiter: RateLimiter;

  constructor() {
    // Rate limit to respect RapidAPI limits
    this.rateLimiter = new RateLimiter(1); // 1 request per second
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

  // Get transcript using RapidAPI (two-step process)
  async getVideoTranscript(videoId: string): Promise<string> {
    if (!config.rapidapiKey || config.rapidapiKey.length < 10) {
      throw new TranscriptError('RapidAPI key not configured');
    }

    try {
      logger.info(`Requesting transcript from RapidAPI for video ${videoId}`);
      
      // Step 1: Request transcript processing
      const initialResponse = await this.requestTranscript(videoId);
      
      if (!initialResponse.process_id) {
        throw new TranscriptError('No process ID returned from RapidAPI');
      }

      logger.info(`RapidAPI process started with ID: ${initialResponse.process_id}`);

      // Step 2: Poll for results
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
        logger.info(`✅ SUCCESS! Transcript ready for video ${videoId} (${result.transcript.length} characters)`);
        return result.transcript;
      }

      // Check for processing failure using NEW format
      if (result.success === false || (result.isProcessed === true && !result.transcript)) {
        throw new TranscriptError(`RapidAPI processing failed: ${result.error || 'Unknown processing error'}`);
      }

      // If we get here, something unexpected happened
      throw new TranscriptError('Unexpected polling result format');
      
    } catch (error) {
      logger.error(`RapidAPI transcript fetch failed for video ${videoId}`, { error });
      throw new TranscriptError(`RapidAPI failed: ${(error as Error).message}`);
    }
  }

  // Step 1: Request transcript processing
  private async requestTranscript(videoId: string): Promise<RapidAPITranscriptResponse> {
    await this.rateLimiter.wait();

    const url = `${config.rapidapiUrl}/transcript?skipAI=true&url=https://www.youtube.com/watch?v=${videoId}`;
    
    return retryWithBackoff(async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-RapidAPI-Host': config.rapidapiHost,
          'X-RapidAPI-Key': config.rapidapiKey,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new TranscriptError(`RapidAPI request failed: HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      
      // Handle both possible field names: process_id or processingId
      const processId = data.process_id || data.processingId;
      
      if (!processId) {
        throw new TranscriptError('Invalid response from RapidAPI: missing process_id/processingId');
      }

      return {
        process_id: processId,
        status: data.status || 'processing'
      } as RapidAPITranscriptResponse;
    }, config.rapidapiMaxRetries, 2000);
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
      
      await this.rateLimiter.wait();
      
      try {
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
          const totalTime = Math.round((Date.now() - startTime) / 1000);
          logger.info(`🎉 SUCCESS! RapidAPI processing completed for ${processId} after ${attempts + 1} attempts (${totalTime}s)`);
          logger.info(`📝 Transcript found: ${result.transcript.length} characters`);
          logger.info(`📄 Transcript preview: "${result.transcript.substring(0, 200)}..."`);
          
          // Record metrics
          try {
            TranscriptLogger.logTranscriptQuality(processId, 'rapidapi', result.transcript);
            TranscriptMetrics.recordAttempt(processId, 'rapidapi-success', true, Date.now() - startTime);
          } catch (metricsError) {
            logger.warn('Metrics logging failed:', { error: metricsError });
          }
          
          return result;
        }
        
        // Check for processing failure - RapidAPI returns success: false when failed
        if (result.success === false || (result.isProcessed === true && !result.transcript)) {
          logger.error(`❌ FAILED! RapidAPI processing failed for ${processId}`, { 
            success: result.success,
            isProcessed: result.isProcessed,
            hasTranscript: !!result.transcript,
            fullResult: result 
          });
          
          try {
            TranscriptMetrics.recordAttempt(processId, 'rapidapi-failed', false, Date.now() - startTime, 'RapidAPI processing failed');
          } catch (metricsError) {
            logger.warn('Metrics logging failed:', { error: metricsError });
          }
          
          return result;
        }
        
        // Still processing (isProcessed: false), log progress and wait
        const progress = (result as any).progress || (result as any).percentage || 'unknown';
        const pollDelay = getPollDelay(attempts);
        
        logger.info(`⏳ STILL PROCESSING: ${processId} - Attempt ${attempts + 1}/${maxAttempts}, Progress: ${progress}%, Next poll in ${pollDelay/1000}s`);
        
        await new Promise(resolve => setTimeout(resolve, pollDelay));
        
      } catch (error) {
        const pollDelay = getPollDelay(attempts);
        logger.warn(`Error polling RapidAPI result for ${processId} (attempt ${attempts + 1}/${maxAttempts})`, { error });
        logger.info(`Retrying in ${pollDelay/1000}s...`);
        
        // Continue polling even if one poll fails
        await new Promise(resolve => setTimeout(resolve, pollDelay));
      }
      
      attempts++;
    }
    
    throw new TranscriptError(`RapidAPI processing timeout after ${maxAttempts} attempts (${Math.round((Date.now() - startTime) / 1000)}s) for process ${processId}`);
  }

  // Get processing result by process ID
  private async getResult(processId: string): Promise<RapidAPIResult> {
    const url = `${config.rapidapiUrl}/result/${processId}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Host': config.rapidapiHost,
        'X-RapidAPI-Key': config.rapidapiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new TranscriptError(`RapidAPI result request failed: HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    
    // Enhanced validation for new response format
    if (!data.success && !data.isProcessed && !data.status) {
      throw new TranscriptError('Invalid response from RapidAPI: missing required fields');
    }

    return data as RapidAPIResult;
  }

  // Check if RapidAPI is properly configured
  isConfigured(): boolean {
    return !!(config.rapidapiKey && config.rapidapiKey.length > 10 && config.rapidapiHost && config.rapidapiUrl);
  }
}

// Export singleton instance
export const rapidapiService = new RapidAPIService();
