export interface FinfluencerChannel {
  id: string;
  channel_id: string;
  channel_name: string;
  is_active: boolean;
  last_checked_at: string | null;
  added_at: string;
}

export interface FinfluencerPrediction {
  id: string;
  channel_id: string;
  channel_name: string;
  video_id: string;
  video_title: string;
  post_date: string;
  language: string;
  transcript_summary: string;
  predictions: Prediction[];
  ai_modifications: AIModification[];
  created_at: string;
  updated_at?: string;
  raw_transcript?: string;
  subject_outcome?: "pending" | "out_of_subject" | "analyzed";
}

export interface Prediction {
  asset: string;
  sentiment: "bullish" | "bearish" | "neutral";
  prediction_text: string;
  prediction_date: string;
  horizon: {
    type: "exact" | "end_of_year" | "quarter" | "month" | "custom";
    value: string;
  };
  target_price: number | null;
  target_price_currency_declared?: string | null; // Currency explicitly mentioned for target price (e.g., "USD", "TRY", "EUR")
  necessary_conditions_for_prediction?: string | null; // Conditions required for prediction to be valid
  confidence: "low" | "medium" | "high";
  quality_score?: number;
  quality_breakdown?: any;
  extraction_metadata?: {
    currency_detection_confidence?: "low" | "medium" | "high"; // Confidence in detected currency
    multiple_currencies_detected?: string[]; // List of all currencies found in text
    selected_currency_reasoning?: string; // Why this currency was chosen if multiple were detected
  };
}

export interface AIModification {
  field: string;
  original_value: string | number;
  corrected_value: string | number;
  reason: string;
}

export interface YouTubeVideo {
  videoId: string;
  title: string;
  publishedAt: string;
  channelId: string;
  channelTitle: string;
  description?: string;
  duration?: string;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
}

export interface AIAnalysisResult {
  channel_id: string | null;
  channel_name: string | null;
  video_id: string | null;
  video_title: string | null;
  post_date: string | null;
  language: string;
  transcript_summary: string;
  predictions: Prediction[];
  ai_modifications: AIModification[];
  quality_score?: number;
  quality_breakdown?: any;
  raw_transcript?: string;
  subject_outcome?: "pending" | "out_of_subject" | "analyzed";
}

export interface CronJobStats {
  /** @deprecated Use RunReport instead */
  total_channels: number;
  processed_channels: number;
  total_videos: number;
  processed_videos: number;
  skipped_videos: number;
  videos_with_captions: number;
  videos_without_captions: number;
  errors: number;
  start_time: Date;
  end_time?: Date;
}

/**
 * Comprehensive run report for the entire pipeline
 * Replaces CronJobStats with detailed metrics per stage
 */
export interface RunReport {
  // Metadata
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: "running" | "success" | "partial" | "failed";
  version: string;

  // Stage 1: Channels & Videos
  channels: {
    total: number;
    processed: number;
    errors: number;
  };
  videos: {
    total: number;
    processed: number;
    skipped: number;
    errors: number;
  };

  // Stage 2: Transcript Fetching
  transcripts: {
    fetched: number;
    failed: number;
    source: string; // Last used source: "rapidapi" | "youtube" | "cache"
    avg_length_chars: number;
    total_chars: number;
  };

  // Stage 3: AI Analysis
  ai_analysis: {
    processed: number;
    predictions_extracted: number;
    out_of_subject: number;
    errors: number;
  };

  // Stage 4: Combined Predictions
  combined_predictions: {
    processed: number;
    inserted: number;
    skipped_duplicates: number;
    errors: number;
  };

  // Stage 5: Price Fetching
  price_fetching: {
    requests: number;
    cache_hits: number;
    api_calls: number;
    success: number;
    failed: number;
    source: string; // Last used source
  };

  // Stage 6: Verification
  verification: {
    processed: number;
    resolved_correct: number;
    resolved_wrong: number;
    still_pending: number;
  };

  // Stage 7: News Fetching
  news: {
    feeds_checked: number;
    items_found: number;
    items_processed: number;
    items_saved: number;
    non_financial: number;
    errors: number;
  };

  // System Health
  system: {
    memory_used_mb: number;
    errors: string[];
  };
}

export interface DatabaseError extends Error {
  code?: string;
  details?: any;
}

export interface YouTubeError extends Error {
  code?: number;
  response?: any;
}

export interface OpenRouterError extends Error {
  status?: number;
  data?: any;
}

export interface ProcessingLog {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  timestamp: Date;
  context?: any;
}

export interface TranscriptError extends Error {
  name: "TranscriptError";
}

export interface RapidAPITranscriptResponse {
  process_id: string;
  status: "processing" | "completed" | "failed";
  transcript?: string;
  error?: string;
  // Also handle alternative field names from API
  processingId?: string;
}

export interface RapidAPIResult {
  // Core RapidAPI fields
  success?: boolean;
  isProcessed?: boolean;
  title?: string;
  language?: string;
  transcript?: string;
  ai_notes?: string | null;
  processor?: string;
  video_id?: string;
  channel_id?: string;
  channel_name?: string;
  post_date?: string;
  last_requested?: string;

  // Legacy fields for backwards compatibility
  process_id?: string;
  status?: "processing" | "completed" | "failed";
  error?: string;
  created_at?: string;
  completed_at?: string;
  // Also handle alternative field names from API
  processingId?: string;
  // Progress percentage from API
  progress?: number;
  percentage?: number;
}
