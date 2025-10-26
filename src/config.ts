import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the project root
dotenv.config({ path: path.join(process.cwd(), '.env') });

export const config = {
  // YouTube API
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  
  // Supabase
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  
  // OpenRouter AI
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3.1:free',
  
  // RapidAPI
  rapidapiHost: process.env.RAPIDAPI_HOST || 'youtube-multi-api.p.rapidapi.com',
  rapidapiKey: process.env.RAPIDAPI_KEY || '',
  rapidapiUrl: process.env.RAPIDAPI_URL || 'https://youtube-multi-api.p.rapidapi.com',
  
  // Application
  startDate: process.env.START_DATE || '2025-01-01',
  timezone: process.env.TZ || 'Europe/Istanbul',
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  
  // API URLs
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  
  // Processing
  maxRetries: 3,
  retryDelay: 1000, // ms
  requestTimeout: 90000, // ms - Extended to 90 seconds
  
  // YouTube API limits
  youtubeMaxResults: 50,
  youtubeApiQuota: 10000,
  
  // OpenRouter settings
  openrouterTemperature: 0.3,
  openrouterMaxTokens: 16000, // Increased for DeepSeek V3.1
  
  // RapidAPI settings
  rapidapiMaxRetries: 5,
  rapidapiPollInterval: 5000, // ms
  rapidapiMaxPollTime: 300000, // 5 minutes
};

// Validation
export function validateConfig(): void {
  console.log('🔍 Configuration Debug:');
  console.log('- YOUTUBE_API_KEY:', process.env.YOUTUBE_API_KEY ? 'PRESENT' : 'MISSING');
  console.log('- SUPABASE_URL:', process.env.SUPABASE_URL ? 'PRESENT' : 'MISSING');
  console.log('- SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? 'PRESENT' : 'MISSING');
  console.log('- OPENROUTER_API_KEY:', process.env.OPENROUTER_API_KEY ? 'PRESENT' : 'MISSING');
  
  console.log('Config values:');
  console.log('- youtubeApiKey:', config.youtubeApiKey ? `${config.youtubeApiKey.length} chars` : 'MISSING');
  console.log('- supabaseUrl:', config.supabaseUrl ? `${config.supabaseUrl.length} chars` : 'MISSING');
  console.log('- supabaseServiceKey:', config.supabaseServiceKey ? `${config.supabaseServiceKey.length} chars` : 'MISSING');
  console.log('- openrouterApiKey:', config.openrouterApiKey ? `${config.openrouterApiKey.length} chars` : 'MISSING');
  console.log('- openrouterModel:', config.openrouterModel);

  const requiredVars = [
    'youtubeApiKey',
    'supabaseUrl', 
    'supabaseServiceKey',
    'openrouterApiKey'
  ];
  
  const missing = requiredVars.filter(key => !config[key as keyof typeof config]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  // Validate date format
  const startDateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!startDateRegex.test(config.startDate)) {
    throw new Error(`Invalid START_DATE format. Expected YYYY-MM-DD, got: ${config.startDate}`);
  }
  
  // Validate YouTube API key format (basic check)
  if (config.youtubeApiKey.length < 20) {
    throw new Error('YouTube API key appears to be invalid (too short)');
  }
  
  // Validate Supabase URL
  try {
    new URL(config.supabaseUrl);
  } catch {
    throw new Error('Invalid SUPABASE_URL format');
  }
  
  // Validate OpenRouter API key
  if (config.openrouterApiKey.length < 20) {
    throw new Error('OpenRouter API key appears to be invalid (too short)');
  }
  
  console.log('✅ Configuration validation successful!');
}

export default config;
