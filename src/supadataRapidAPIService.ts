import axios, { AxiosResponse } from 'axios';
import { config } from './config';
import { RapidAPIResult } from './types';
import { logger, retryWithBackoff, RateLimitMonitor } from './utils';

export class SupadataRapidAPIService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly host: string;

  constructor() {
    // Supadata RapidAPI endpoint configuration
    this.baseUrl = 'https://youtube-transcript.p.rapidapi.com';
    this.host = 'youtube-transcript.p.rapidapi.com';
    this.apiKey = config.rapidapiKey;
  }

  // Check if service is configured
  isConfigured(): boolean {
    return !!(this.apiKey && this.apiKey.trim() !== '');
  }

  // Test RapidAPI connection for Supadata
  async testConnection(): Promise<boolean> {
    if (!this.isConfigured()) {
      throw new Error('Supadata RapidAPI not configured - missing API key');
    }

    try {
      const response = await this.makeRequest('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      
      if (response && (response.success !== false)) {
        logger.info('Supadata RapidAPI connection successful');
        return true;
      }
      
      throw new Error('Invalid response from Supadata RapidAPI');
    } catch (error) {
      logger.error('Supadata RapidAPI connection test failed', { error });
      throw error;
    }
  }

  // Get video transcript via Supadata RapidAPI
  async getVideoTranscript(videoId: string): Promise<string | null> {
    if (!this.isConfigured()) {
      throw new Error('Supadata RapidAPI not configured');
    }

    if (!videoId || typeof videoId !== 'string') {
      throw new Error('Invalid video ID provided');
    }

    try {
      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
      logger.info(`Fetching transcript via Supadata RapidAPI for video ${videoId}`);

      const response = await this.makeRequest(youtubeUrl);
      
      if (!response) {
        throw new Error('No response from Supadata RapidAPI');
      }

      // Handle different response formats
      let transcript = '';
      
      if (typeof response === 'string') {
        transcript = response;
      } else if (response.transcript) {
        transcript = response.transcript;
      } else if (response.content) {
        transcript = response.content;
      } else if (response.text) {
        transcript = response.text;
      } else {
        // Check if it's a successful response with transcript data
        if (response.success === true || response.isProcessed === true) {
          transcript = response.transcript || response.content || response.text || '';
        } else {
          throw new Error('No transcript found in response');
        }
      }

      if (!transcript || transcript.trim().length === 0) {
        throw new Error('Empty transcript received');
      }

      // Record successful request
      RateLimitMonitor.recordRequest('supadata-rapidapi', true, Date.now());
      
      logger.info(`Successfully fetched transcript via Supadata RapidAPI for video ${videoId}`, {
        transcriptLength: transcript.length,
        source: 'supadata-rapidapi'
      });

      return transcript.trim();

    } catch (error) {
      // Record failed request
      RateLimitMonitor.recordRequest('supadata-rapidapi', false, Date.now());
      
      const errorMessage = (error as Error).message;
      logger.error(`Supadata RapidAPI transcript failed for video ${videoId}`, { 
        error: errorMessage,
        source: 'supadata-rapidapi'
      });

      // Handle specific error types
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        throw new Error('Supadata RapidAPI rate limit exceeded');
      } else if (errorMessage.includes('insufficient') || errorMessage.includes('credit')) {
        throw new Error('Supadata RapidAPI credits exhausted');
      } else if (errorMessage.includes('not found') || errorMessage.includes('unavailable')) {
        throw new Error('Video transcript not available');
      }

      throw error;
    }
  }

  // Make HTTP request to Supadata RapidAPI
  private async makeRequest(url: string): Promise<any> {
    const requestBody = {
      url: url,
      lang: 'en', // Default to English, can be made configurable
      text: true, // Return plain text
      mode: 'auto' // Try native first, fallback to generate
    };

    try {
      const response: AxiosResponse = await axios.post(
        `${this.baseUrl}/transcript`,
        requestBody,
        {
          headers: {
            'X-RapidAPI-Key': this.apiKey,
            'X-RapidAPI-Host': this.host,
            'Content-Type': 'application/json'
          },
          timeout: 30000, // 30 second timeout
          validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        }
      );

      if (response.status === 429) {
        throw new Error('Rate limit exceeded (429)');
      } else if (response.status === 402) {
        throw new Error('Payment required - credits exhausted');
      } else if (response.status === 404) {
        throw new Error('Transcript not found (404)');
      } else if (response.status >= 400) {
        throw new Error(`API error: ${response.status} - ${response.data?.message || 'Unknown error'}`);
      }

      return response.data;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          throw new Error('Request timeout');
        } else if (error.response?.status === 429) {
          throw new Error('Rate limit exceeded');
        } else if (error.response?.status === 402) {
          throw new Error('Payment required - credits exhausted');
        } else if (error.response?.status === 404) {
          throw new Error('Transcript not found');
        } else {
          throw new Error(`Network error: ${error.message}`);
        }
      }
      
      throw error;
    }
  }

  // Get rate limiting statistics
  getRateLimitStats(): any {
    return RateLimitMonitor.getStats('supadata-rapidapi');
  }

  // Reset rate limiting metrics (for testing)
  resetMetrics(): void {
    RateLimitMonitor.reset('supadata-rapidapi');
  }
}

// Export singleton instance
export const supadataRapidAPIService = new SupadataRapidAPIService();
