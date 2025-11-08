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
  subject_outcome?: 'pending' | 'out_of_subject' | 'analyzed';
}

export interface Prediction {
  asset: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  prediction_text: string;
  prediction_date: string;
  horizon: {
    type: 'exact' | 'end_of_year' | 'quarter' | 'month' | 'custom';
    value: string;
  };
  target_price: number | null;
  confidence: 'low' | 'medium' | 'high';
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
  raw_transcript?: string;
  subject_outcome?: 'pending' | 'out_of_subject' | 'analyzed';
}

export interface CronJobStats {
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
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: Date;
  context?: any;
}

export interface TranscriptError extends Error {
  name: 'TranscriptError';
}

export interface RapidAPITranscriptResponse {
  process_id: string;
  status: 'processing' | 'completed' | 'failed';
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
  status?: 'processing' | 'completed' | 'failed';
  error?: string;
  created_at?: string;
  completed_at?: string;
  // Also handle alternative field names from API
  processingId?: string;
  // Progress percentage from API
  progress?: number;
  percentage?: number;
}
