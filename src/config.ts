import dotenv from "dotenv";
import path from "path";

// Load environment variables from the project root
dotenv.config({ path: path.join(process.cwd(), ".env") });

export const config = {
  // YouTube API
  youtubeApiKey: process.env.YOUTUBE_API_KEY || "",

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || "",

  // OpenRouter AI
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openrouterModel:
    process.env.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL_2,
  openrouterModel2: process.env.OPENROUTER_MODEL_2,

  // RapidAPI
  rapidapiHost: process.env.RAPIDAPI_HOST || "youtube-multi-api.p.rapidapi.com",
  rapidapiKey: process.env.RAPIDAPI_KEY || "",
  rapidapiUrl:
    process.env.RAPIDAPI_URL || "https://youtube-multi-api.p.rapidapi.com",

  // Supadata
  supadataApiKey: process.env.SUPADATA_API_KEY || "",
  supadataUrl: process.env.SUPADATA_URL || "https://api.supadata.ai/v1",
  rapidapiSupadataUrl: process.env.RAPIDAPI_SUPADATA_URL || "",

  // CoinMarketCap
  cmcProApiKey: process.env.CMC_PRO_API_KEY || "",
  coingeckoApiKey: process.env.COINGECKO_API_KEY || "",

  // Application
  startDate: process.env.START_DATE || "2025-01-01",
  timezone: process.env.TZ || "Europe/Istanbul",

  // Logging
  logLevel: process.env.LOG_LEVEL || "info",

  // API URLs
  openrouterBaseUrl: "https://openrouter.ai/api/v1",

  // Processing
  maxRetries: 3,
  retryDelay: 1000, // ms
  requestTimeout: 90000, // ms - Extended to 90 seconds

  // YouTube API limits
  youtubeMaxResults: 50,
  youtubeApiQuota: 10000,

  // OpenRouter settings
  openrouterTemperature: 0.4,
  openrouterMaxTokens: 16000, // Increased for DeepSeek V3.1

  // RapidAPI settings
  rapidapiMaxRetries: 5,
  rapidapiPollInterval: 5000, // ms
  rapidapiMaxPollTime: 300000, // 5 minutes

  // Supadata settings
  supadataMaxRetries: 3,
  supadataPollInterval: 5000, // ms
  supadataMaxPollTime: 1500000, // 25 minutes (same as RapidAPI)
  supadataCreditsThreshold: 20, // Switch to RapidAPI version when main credits < 20

  // Enhanced Rate Limiting Configuration
  rateLimiting: {
    // Retry Service Settings
    retryBatchSize: parseInt(process.env.RETRY_BATCH_SIZE) || 5, // Reduced from 10 to 5
    retryBatchDelay: parseInt(process.env.RETRY_BATCH_DELAY) || 12000, // Increased to 12s
    retrySequentialDelay: parseInt(process.env.RETRY_SEQUENTIAL_DELAY) || 3000, // 3s between records
    max429Retries: parseInt(process.env.MAX_429_RETRIES) || 3,

    // RapidAPI Endpoint Rate Limits (requests per second)
    rapidapiInfoRps: parseFloat(process.env.RAPIDAPI_INFO_RPS) || 0.7, // 1 request per ~1.4s
    rapidapiTranscriptRps:
      parseFloat(process.env.RAPIDAPI_TRANSCRIPT_RPS) || 0.5, // 1 request per 2s
    rapidapiResultRps: parseFloat(process.env.RAPIDAPI_RESULT_RPS) || 1.0, // 1 request per second

    // Supadata Rate Limits (requests per second)
    supadataTranscriptRps:
      parseFloat(process.env.SUPADATA_TRANSCRIPT_RPS) || 0.3, // 1 request per ~3.3s (conservative for credit management)
    supadataResultRps: parseFloat(process.env.SUPADATA_RESULT_RPS) || 0.5, // 1 request per 2s

    // Circuit Breaker Settings
    circuitBreakerFailureThreshold:
      parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD) || 8,
    circuitBreakerResetTimeout:
      parseInt(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT) || 120000, // 2 minutes

    // 429 Error Handling
    maxRateLimitRetries: parseInt(process.env.MAX_RATE_LIMIT_RETRIES) || 5,
    baseRateLimitDelay: parseInt(process.env.BASE_RATE_LIMIT_DELAY) || 2000, // 2 seconds
    rateLimitJitter: parseFloat(process.env.RATE_LIMIT_JITTER) || 0.5, // 50% jitter

    // Jitter Configuration
    jitterPercentage: parseFloat(process.env.JITTER_PERCENTAGE) || 0.25, // 25% jitter
  },

  // Rate Limit Monitoring
  monitoring: {
    enableMetrics: process.env.ENABLE_RATE_LIMIT_METRICS === "true" || true,
    logLevelDetailed: process.env.LOG_LEVEL_DETAILED === "true" || false,
    alertOnRateLimit: process.env.ALERT_ON_RATE_LIMIT === "true" || true,
  },

  // Credit Management
  credits: {
    trackUsage: process.env.TRACK_CREDITS === "true" || true,
    logUsage: process.env.LOG_CREDIT_USAGE === "true" || true,
    warnThreshold: parseInt(process.env.CREDIT_WARN_THRESHOLD) || 20,
    switchPlatform:
      process.env.SWITCH_PLATFORM_ON_LOW_CREDITS === "true" || true,
  },
};

// Validation
export function validateConfig(): void {
  console.log("🔍 Configuration Debug:");
  console.log(
    "- YOUTUBE_API_KEY:",
    process.env.YOUTUBE_API_KEY ? "PRESENT" : "MISSING"
  );
  console.log(
    "- SUPABASE_URL:",
    process.env.SUPABASE_URL ? "PRESENT" : "MISSING"
  );
  console.log(
    "- SUPABASE_SERVICE_KEY:",
    process.env.SUPABASE_SERVICE_KEY ? "PRESENT" : "MISSING"
  );
  console.log(
    "- OPENROUTER_API_KEY:",
    process.env.OPENROUTER_API_KEY ? "PRESENT" : "MISSING"
  );
  console.log(
    "- SUPADATA_API_KEY:",
    process.env.SUPADATA_API_KEY ? "PRESENT" : "MISSING"
  );

  console.log("Config values:");
  console.log(
    "- youtubeApiKey:",
    config.youtubeApiKey ? `${config.youtubeApiKey.length} chars` : "MISSING"
  );
  console.log(
    "- supabaseUrl:",
    config.supabaseUrl ? `${config.supabaseUrl.length} chars` : "MISSING"
  );
  console.log(
    "- supabaseServiceKey:",
    config.supabaseServiceKey
      ? `${config.supabaseServiceKey.length} chars`
      : "MISSING"
  );
  console.log(
    "- openrouterApiKey:",
    config.openrouterApiKey
      ? `${config.openrouterApiKey.length} chars`
      : "MISSING"
  );
  console.log(
    "- supadataApiKey:",
    config.supadataApiKey ? `${config.supadataApiKey.length} chars` : "MISSING"
  );
  console.log("- openrouterModel:", config.openrouterModel);

  console.log("Rate Limiting Configuration:");
  console.log("- Retry Batch Size:", config.rateLimiting.retryBatchSize);
  console.log(
    "- Retry Batch Delay:",
    config.rateLimiting.retryBatchDelay + "ms"
  );
  console.log(
    "- Sequential Delay:",
    config.rateLimiting.retrySequentialDelay + "ms"
  );
  console.log("- Info RPS:", config.rateLimiting.rapidapiInfoRps);
  console.log("- Transcript RPS:", config.rateLimiting.rapidapiTranscriptRps);
  console.log("- Result RPS:", config.rateLimiting.rapidapiResultRps);
  console.log(
    "- Supadata Transcript RPS:",
    config.rateLimiting.supadataTranscriptRps
  );
  console.log("- Supadata Result RPS:", config.rateLimiting.supadataResultRps);
  console.log(
    "- Circuit Breaker Threshold:",
    config.rateLimiting.circuitBreakerFailureThreshold
  );
  console.log(
    "- Circuit Breaker Reset Timeout:",
    config.rateLimiting.circuitBreakerResetTimeout + "ms"
  );
  console.log("- Supadata Credits Threshold:", config.supadataCreditsThreshold);

  const requiredVars = [
    "youtubeApiKey",
    "supabaseUrl",
    "supabaseServiceKey",
    "openrouterApiKey",
  ];

  const missing = requiredVars.filter(
    (key) => !config[key as keyof typeof config]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  // Validate date format
  const startDateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!startDateRegex.test(config.startDate)) {
    throw new Error(
      `Invalid START_DATE format. Expected YYYY-MM-DD, got: ${config.startDate}`
    );
  }

  // Validate YouTube API key format (basic check)
  if (config.youtubeApiKey.length < 20) {
    throw new Error("YouTube API key appears to be invalid (too short)");
  }

  // Validate Supabase URL
  try {
    new URL(config.supabaseUrl);
  } catch {
    throw new Error("Invalid SUPABASE_URL format");
  }

  // Validate OpenRouter API key
  if (config.openrouterApiKey.length < 20) {
    throw new Error("OpenRouter API key appears to be invalid (too short)");
  }

  // Validate rate limiting values
  if (
    config.rateLimiting.retryBatchSize <= 0 ||
    config.rateLimiting.retryBatchSize > 20
  ) {
    throw new Error("RETRY_BATCH_SIZE must be between 1 and 20");
  }

  if (
    config.rateLimiting.retryBatchDelay < 1000 ||
    config.rateLimiting.retryBatchDelay > 60000
  ) {
    throw new Error("RETRY_BATCH_DELAY must be between 1000ms and 60000ms");
  }

  if (
    config.rateLimiting.rapidapiInfoRps <= 0 ||
    config.rateLimiting.rapidapiInfoRps > 5
  ) {
    throw new Error("RAPIDAPI_INFO_RPS must be between 0.1 and 5");
  }

  if (
    config.rateLimiting.rapidapiTranscriptRps <= 0 ||
    config.rateLimiting.rapidapiTranscriptRps > 5
  ) {
    throw new Error("RAPIDAPI_TRANSCRIPT_RPS must be between 0.1 and 5");
  }

  if (
    config.rateLimiting.rapidapiResultRps <= 0 ||
    config.rateLimiting.rapidapiResultRps > 5
  ) {
    throw new Error("RAPIDAPI_RESULT_RPS must be between 0.1 and 5");
  }

  console.log("✅ Configuration validation successful!");
}

export default config;
