import winston from 'winston';
import { config } from './config';
import { ProcessingLog } from './types';

// Logger configuration
export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'finfluencer-tracker' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Retry mechanism with exponential backoff
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = config.maxRetries,
  baseDelay: number = config.retryDelay
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === maxRetries) {
        logger.error(`Operation failed after ${maxRetries} retries`, {
          error: lastError.message,
          stack: lastError.stack
        });
        throw lastError;
      }
      
      const delay = baseDelay * Math.pow(2, attempt);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
        error: lastError.message
      });
      
      await sleep(delay);
    }
  }
  
  throw lastError!;
}

// Sleep utility
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Safe JSON parsing with fallback
export function safeJsonParse<T>(jsonString: string, fallback: T): T {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logger.warn('Failed to parse JSON, using fallback', {
      error: (error as Error).message,
      jsonString: jsonString.substring(0, 200) + '...'
    });
    return fallback;
  }
}

// JSON response cleanup for common AI response issues
export function cleanJsonResponse(response: string): string {
  let cleaned = response.trim();
  
  // Remove markdown code blocks
  cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
  
  // Remove common AI response prefixes
  cleaned = cleaned.replace(/^(Here is|Here's|The result is|Result:)\s*/i, '');
  
  // Fix common JSON formatting issues
  cleaned = cleaned.replace(/,\s*}/g, '}'); // Remove trailing commas
  cleaned = cleaned.replace(/,\s*]/g, ']'); // Remove trailing commas in arrays
  
  // Handle escaped quotes
  cleaned = cleaned.replace(/\\"/g, '"');
  
  return cleaned;
}

// Validate YouTube video ID format
export function isValidYouTubeVideoId(videoId: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId);
}

// Validate YouTube channel ID format
export function isValidYouTubeChannelId(channelId: string): boolean {
  return /^[a-zA-Z0-9_-]{24}$/.test(channelId) || /^UC[a-zA-Z0-9_-]{22}$/.test(channelId);
}

// Format date for database storage
export function formatDateForDB(date: Date | string): string {
  if (typeof date === 'string') {
    return date;
  }
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Parse YouTube duration (PT4M13S format) to seconds
export function parseYouTubeDuration(duration: string): number {
  const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  if (!match) return 0;
  
  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');
  
  return hours * 3600 + minutes * 60 + seconds;
}

// Extract video ID from YouTube URL
export function extractVideoIdFromUrl(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

// Detect language from text (simple implementation)
export function detectLanguage(text: string): string {
  // Simple language detection based on common words
  const turkishWords = ['ve', 'bir', 'bu', 'için', 'ama', 'çok', 'daha', 'ile', 'olarak', 'yapmak'];
  const englishWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'will'];
  
  const lowerText = text.toLowerCase();
  const turkishCount = turkishWords.filter(word => lowerText.includes(word)).length;
  const englishCount = englishWords.filter(word => lowerText.includes(word)).length;
  
  if (turkishCount > englishCount) return 'tr';
  if (englishCount > turkishCount) return 'en';
  
  return 'unknown';
}

// Sanitize text for database storage
export function sanitizeText(text: string): string {
  return text
    .replace(/\s+/g, ' ') // Normalize whitespace
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim();
}

// Calculate processing statistics
export function calculateProcessingStats(logs: ProcessingLog[]): {
  totalProcessed: number;
  errors: number;
  warnings: number;
  avgProcessingTime?: number;
} {
  const totalProcessed = logs.filter(log => log.level === 'info').length;
  const errors = logs.filter(log => log.level === 'error').length;
  const warnings = logs.filter(log => log.level === 'warn').length;
  
  return {
    totalProcessed,
    errors,
    warnings
  };
}

// Memory usage monitoring
export function getMemoryUsage(): {
  used: number;
  total: number;
  percentage: number;
} {
  const usage = process.memoryUsage();
  const used = usage.heapUsed;
  const total = usage.heapTotal;
  const percentage = (used / total) * 100;
  
  return {
    used: Math.round(used / 1024 / 1024), // MB
    total: Math.round(total / 1024 / 1024), // MB
    percentage: Math.round(percentage * 100) / 100
  };
}

// Graceful shutdown handler
export function setupGracefulShutdown(handler: () => Promise<void>): void {
  const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
  
  signals.forEach(signal => {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);
      try {
        await handler();
        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during graceful shutdown', { error });
        process.exit(1);
      }
    });
  });
}

// Rate limiting helper
export class RateLimiter {
  private lastRequest = 0;
  private minInterval: number;

  constructor(requestsPerSecond: number) {
    this.minInterval = 1000 / requestsPerSecond;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;
    
    if (timeSinceLastRequest < this.minInterval) {
      const waitTime = this.minInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequest = Date.now();
  }
}

// Transcript processing metrics tracker
export class TranscriptMetrics {
  private static metrics: Map<string, {
    attempts: number;
    successes: number;
    failures: number;
    methods: Map<string, { attempts: number; successes: number; failures: number }>;
    totalProcessingTime: number;
    averageProcessingTime: number;
  }> = new Map();

  static recordAttempt(videoId: string, method: string, success: boolean, processingTime: number, error?: string): void {
    const existing = this.metrics.get(videoId) || {
      attempts: 0,
      successes: 0,
      failures: 0,
      methods: new Map(),
      totalProcessingTime: 0,
      averageProcessingTime: 0
    };

    existing.attempts++;
    existing.totalProcessingTime += processingTime;
    existing.averageProcessingTime = existing.totalProcessingTime / existing.attempts;

    if (success) {
      existing.successes++;
    } else {
      existing.failures++;
    }

    // Track method-specific metrics
    const methodMetrics = existing.methods.get(method) || { attempts: 0, successes: 0, failures: 0 };
    methodMetrics.attempts++;
    if (success) {
      methodMetrics.successes++;
    } else {
      methodMetrics.failures++;
    }
    existing.methods.set(method, methodMetrics);

    this.metrics.set(videoId, existing);

    // Log detailed metrics
    logger.debug(`Transcript metrics for ${videoId} - Method: ${method}, Success: ${success}, Time: ${processingTime}ms, Error: ${error || 'none'}`);
  }

  static getMetrics(videoId?: string): any {
    if (videoId) {
      return this.metrics.get(videoId);
    }
    
    // Return overall metrics
    const allMetrics = Array.from(this.metrics.values());
    const totalAttempts = allMetrics.reduce((sum, m) => sum + m.attempts, 0);
    const totalSuccesses = allMetrics.reduce((sum, m) => sum + m.successes, 0);
    const totalFailures = allMetrics.reduce((sum, m) => sum + m.failures, 0);
    
    const methodStats: { [key: string]: { attempts: number; successes: number; failures: number; successRate: number } } = {};
    
    allMetrics.forEach(metrics => {
      metrics.methods.forEach((methodMetrics, method) => {
        if (!methodStats[method]) {
          methodStats[method] = { attempts: 0, successes: 0, failures: 0, successRate: 0 };
        }
        methodStats[method].attempts += methodMetrics.attempts;
        methodStats[method].successes += methodMetrics.successes;
        methodStats[method].failures += methodMetrics.failures;
        methodStats[method].successRate = methodStats[method].attempts > 0 
          ? (methodStats[method].successes / methodStats[method].attempts) * 100 
          : 0;
      });
    });

    return {
      overall: {
        totalAttempts,
        totalSuccesses,
        totalFailures,
        overallSuccessRate: totalAttempts > 0 ? (totalSuccesses / totalAttempts) * 100 : 0
      },
      byMethod: methodStats
    };
  }

  static clearMetrics(videoId?: string): void {
    if (videoId) {
      this.metrics.delete(videoId);
    } else {
      this.metrics.clear();
    }
  }
}

// Enhanced logging for transcript debugging
export class TranscriptLogger {
  static logApiCall(method: string, videoId: string, url: string, headers: any, response?: any, error?: any): void {
    const logData = {
      timestamp: new Date().toISOString(),
      method,
      videoId,
      url: url.replace(/key=[^&]*/, 'key=REDACTED'), // Hide API key in logs
      headers: { ...headers, 'X-RapidAPI-Key': headers['X-RapidAPI-Key'] ? 'REDACTED' : undefined },
      responseStatus: response?.status,
      responseSuccess: response?.ok,
      error: error?.message || error
    };

    if (error) {
      logger.error(`API Call Failed - ${method}`, logData);
    } else {
      logger.debug(`API Call - ${method}`, logData);
    }
  }

  static logCaptionTracks(videoId: string, tracks: any[], selectedTrack?: any): void {
    const trackInfo = tracks.map((track, index) => ({
      index,
      languageCode: track.languageCode || track.language,
      language: track.language,
      name: track.name,
      kind: track.kind,
      isAutoGenerated: track.kind === 'asr' || track.name?.toLowerCase().includes('auto'),
      hasBaseUrl: !!track.baseUrl,
      selected: selectedTrack === track
    }));

    logger.debug(`Caption tracks for ${videoId}`, { tracks: trackInfo, selectedTrack: selectedTrack?.languageCode || selectedTrack?.language });
  }

  static logPollingAttempt(processId: string, attempt: number, maxAttempts: number, progress: any, nextPollIn: number): void {
    logger.debug(`RapidAPI Polling - Process: ${processId}, Attempt: ${attempt}/${maxAttempts}, Progress: ${progress}%, Next poll: ${nextPollIn}s`);
  }

  static logTranscriptQuality(videoId: string, method: string, transcript: string): void {
    const quality = {
      length: transcript.length,
      wordCount: transcript.split(/\s+/).length,
      lineCount: transcript.split('\n').length,
      hasLineBreaks: transcript.includes('\n'),
      averageWordsPerLine: transcript.split('\n').length > 0 ? transcript.split(/\s+/).length / transcript.split('\n').length : 0,
      likelyCaptions: transcript.includes('\n') && transcript.split(/\s+/).length / transcript.split('\n').length < 15, // Captions typically have <15 words per line
      timestamp: new Date().toISOString()
    };

    logger.debug(`Transcript quality for ${videoId} - Method: ${method}`, quality);
  }
}
