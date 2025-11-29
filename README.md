# Automated YouTube Transcript Generator v1.2.6

A Dockerized microservice designed to run as a daily cron job that analyzes YouTube "finfluencer" videos for financial predictions and saves structured results to Supabase.

## 🎯 Purpose

The cron job automatically:

1. Fetches active YouTube channel IDs from a Supabase table
2. Retrieves new videos since each channel's last check date
3. Downloads video transcripts using YouTube Data API v3 + RapidAPI
4. Validates transcript quality (minimum 50 characters, real captions)
5. Analyzes transcripts using AI models hosted on OpenRouter
6. Parses structured JSON output and saves to Supabase
7. **Automatically retries failed predictions during idle time**
8. Updates channel processing timestamps
9. Runs nightly at 23:30 (Europe/Istanbul, UTC+3)

## ✨ Key Features

- **🔄 Intelligent Retry Service**: Automatic recovery mechanism for failed predictions
- **📊 Batch Processing**: Efficient processing with rate limiting and error isolation
- **🤖 AI-Powered Analysis**: Multiple AI model support via OpenRouter
- **📝 Real-time Logging**: Comprehensive monitoring and statistics with CronJobStats
- **🛡️ Robust Error Handling**: Graceful degradation and recovery mechanisms
- **⚡ Performance Optimized**: Memory-efficient processing with adaptive polling
- **🎯 Transcript Validation**: Heuristic validation to ensure real captions/subtitles

- **🔁 Ticker Normalization**: Curated mapping + AI fallback to resolve ambiguous asset names to exchange-qualified tickers
- **📉 Smart Price API Fallback**: Multi-provider price fetching (AlphaVantage → Finnhub → TwelveData → Yahoo) with per-provider rate-limit detection and automatic cascading

## 🛠️ Tech Stack

- **Language**: TypeScript (Node.js 20+)
- **Framework**: Next.js 14+ (for web interface components)
- **Styling**: Tailwind CSS (utility-first CSS framework)
- **Scheduler**: Northflank Cron Job (daily at 23:30)
- **Database**: Supabase (PostgreSQL)
- **AI Provider**: OpenRouter API (for transcript analysis)
- **Supabase AI**: Supabase AI service for enhanced analysis capabilities
- **YouTube API**: YouTube Data API v3 + RapidAPI (for transcript retrieval)
- **Transcript Provider**: RapidAPI (youtube-multi-api service)
 - **Price APIs**: AlphaVantage, Finnhub, TwelveData, Yahoo Finance (multi-provider fallback for historical prices)
 - **Deployment**: Docker
- **Configuration**: Environment variables

## 📁 Project Structure

```bash
/src
 ├─ index.ts                     # Main FinfluencerTracker class with cron logic
 ├─ youtube.ts                   # YouTube Data API v3 service
 ├─ rapidapi.ts                  # RapidAPI transcript service
 ├─ enhancedAnalyzer.ts          # AI analysis using OpenRouter with Supabase AI integration
 ├─ supabase.ts                  # Database operations and health checks
 ├─ supadataService.ts           # Supabase AI service for transcript analysis
 ├─ supadataRapidAPIService.ts   # Supabase AI service for RapidAPI integration
 ├─ types.ts                     # TypeScript interfaces and types
 ├─ utils.ts                     # Logging, retries, JSON validation, utilities
 ├─ config.ts                    # Environment configuration and validation
 ├─ errors.ts                    # Custom error classes
 ├─ retryService.ts              # Automatic retry service for failed predictions
 ├─ combinedPredictionsService.ts # Combines predictions, fetches prices, AI enrichment
 ├─ tickerNormalizationService.ts # Normalizes asset names to tickers (mapping + AI fallback)
 ├─ tickerMapping.json           # Curated mapping of common asset names → tickers
 ├─ scripts/run-dry-run.ts       # Consolidated dry-run script (CLI)
 ├─ migrations/001_add_prediction_fields.sql # SQL migration for combined_predictions fields
 ├─ jsonUtils.ts                 # JSON parsing and validation utilities
 └─ version.ts                   # Version management and build information
```

Additional files:

### Table 3 — `combined_predictions`

This table stores enriched predictions after normalization, price fetching and optional AI enrichment. A SQL migration is included at `migrations/001_add_prediction_fields.sql` to add the fields described below.

| Column                         | Type        | Description |
| ------------------------------ | ----------- | ----------- |
| id                             | uuid (pk)   | Auto-generated UUID |
| video_id                       | text        | YouTube video ID |
| asset                          | text        | Asset string as extracted from prediction |
| suggested_ticker               | varchar     | Normalized ticker suggested by service |
| suggested_ticker_confidence    | numeric     | Confidence score (0.00 - 1.00) |
| asset_entry_price              | numeric     | Historical price at post date |
| target_price                   | numeric     | Target price parsed from prediction |
| horizon_value                  | text/date   | Horizon value or date string |
| status                         | varchar     | pending | correct | wrong | inconclusive |
| actual_price                   | numeric     | Price at horizon (for reconciliation) |
| resolved_at                    | timestamp   | When reconciliation was performed |
| ai_analysis                    | text        | AI enrichment JSON/text |
| created_at                     | timestamp   | Default now() |

To apply the migration locally or in your environment, run the SQL in `migrations/001_add_prediction_fields.sql` against your Supabase/Postgres instance.

```
update-docker-versioned.ps1       # Docker version update script
```

## 🗄️ Database Schema

### Table 1 — `finfluencer_channels`

| Column          | Type      | Description                     |
| --------------- | --------- | ------------------------------- |
| id              | uuid (pk) | Auto-generated UUID             |
| channel_id      | text      | YouTube channel ID              |
| channel_name    | text      | Channel's display name          |
| is_active       | boolean   | Whether to include this channel |
| last_checked_at | timestamp | Date last processed             |
| added_at        | timestamp | Default now()                   |

### Table 2 — `finfluencer_predictions`

| Column             | Type      | Description                       |
| ------------------ | --------- | --------------------------------- |
| id                 | uuid (pk) | Auto-generated UUID               |
| channel_id         | text      | YouTube channel ID                |
| channel_name       | text      | Channel name                      |
| video_id           | text      | YouTube video ID                  |
| video_title        | text      | Video title                       |
| post_date          | date      | Video publish date                |
| language           | text      | Detected language                 |
| transcript_summary | text      | Summary of content                |
| predictions        | jsonb     | JSON array of predictions         |
| ai_modifications   | jsonb     | JSON corrections (if any)         |
| retry_count        | integer   | Number of retry attempts (0-3)    |
| last_retry_at      | timestamp | Last retry attempt timestamp      |
| retry_reason       | text      | Error message from failures       |
| created_at         | timestamp | Default now()                     |

### Data Structures

**Prediction Interface:**
```typescript
interface Prediction {
  asset: string;                    // e.g., "BTC", "AAPL"
  sentiment: 'bullish'|'bearish'|'neutral';
  prediction_text: string;          // Full prediction text
  prediction_date: string;          // When prediction was made
  horizon: {                        // Time horizon for prediction
    type: 'exact'|'end_of_year'|'quarter'|'month'|'custom';
    value: string;                  // Date or period value
  };
  target_price: number|null;        // Target price if mentioned
  confidence: 'low'|'medium'|'high'; // AI confidence level
}
```

**CronJobStats Interface:**
```typescript
interface CronJobStats {
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
```

## 🔐 Environment Variables

Create a `.env` file based on `.env.example`:

```bash
# YouTube API Configuration
YOUTUBE_API_KEY=your_youtube_api_key_here

# Supabase Configuration
SUPABASE_URL=your_supabase_project_url_here
SUPABASE_SERVICE_KEY=your_supabase_service_role_key_here

# OpenRouter AI Configuration
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_MODEL=your_preferred_model

# Price API Keys (used for historical price fetching and fallbacks)
ALPHA_VANTAGE_API_KEY=your_alphavantage_api_key_here
FINNHUB_API_KEY=your_finnhub_api_key_here
TWELVE_DATA_API_KEY=your_twelvedata_api_key_here

# RapidAPI Configuration (YouTube Transcript Service)
RAPIDAPI_HOST=youtube-multi-api.p.rapidapi.com
RAPIDAPI_KEY=your_rapidapi_key_here
RAPIDAPI_URL=https://youtube-multi-api.p.rapidapi.com

# Application Configuration
START_DATE=2025-01-01
TZ=Europe/Istanbul

# Logging Configuration
LOG_LEVEL=info

# Retry Service Configuration
MAX_RETRY_ATTEMPTS=3
RETRY_BATCH_SIZE=10
RETRY_DELAY_BETWEEN_BATCHES=5000
```

## 🚀 Installation & Setup

### 1. Clone and Install Dependencies

```bash
git clone <repository-url>
cd automated-yt-transcript-cron-job
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your actual API keys and configuration
```

### 3. Build the Application

```bash
npm run build
```

### 4. Local Development

```bash
npm run dev
```

### 5. Production Build

```bash
npm run build
npm start
```

### Running Dry-Run (local testing)

Use the consolidated dry-run script to test processing locally. Examples:

```bash
# Quick single-record test (fetches prices by default)
npx ts-node -T scripts/run-dry-run.ts --limit 1

# Default test (10 records)
npx ts-node -T scripts/run-dry-run.ts

# AI-enabled run (slower, more thorough)
npx ts-node -T scripts/run-dry-run.ts --enable-ai --limit 5

# AI-only analysis (skip price fetching)
npx ts-node -T scripts/run-dry-run.ts --skip-price --limit 10
```

## 🐳 Docker Deployment

### Build Docker Image

```bash
docker build -t finfluencer-tracker:v1.2.6 .
```

### Run with Environment File

```bash
docker run --env-file .env finfluencer-tracker:v1.2.6
```

### Run in Background

```bash
docker run -d --name finfluencer-tracker --env-file .env finfluencer-tracker:v1.2.6
```

## 🌐 Northflank Deployment

### 1. Push Docker Image

Push your built image to a container registry (Docker Hub, GitHub Container Registry, etc.)

### 2. Create Northflank Cron Job

1. Go to Northflank dashboard
2. Create new **Cron Job**
3. Set **Schedule**:
   - **Time**: `23:30`
   - **Timezone**: `Europe/Istanbul` (UTC+3)
   - **Frequency**: Daily
4. Add Environment Variables from `.env`
5. Select your Docker image
6. Deploy

### 3. Monitor Logs

Check Northflank logs for:
- Number of channels processed
- New videos found
- Analysis results
- **Retry service statistics**
- Any errors

## 🧠 AI Analysis

The service uses OpenRouter API to analyze video transcripts for financial predictions. The AI analyzes:

- **Asset predictions** (BTC, GOLD, AAPL, BIST, NASDAQ, S&P500, etc.)
- **Future-oriented statements** (price forecasts, market direction)
- **Time horizons** (exact dates, end of year, quarters, etc.)
- **Sentiment analysis** (bullish, bearish, neutral)
- **Target prices** with automatic error correction
- **Confidence levels** (low, medium, high)

### OpenRouter Models

The service supports various AI models through OpenRouter. You can configure the model by setting the `OPENROUTER_MODEL` environment variable:

- **DeepSeek Chat V3.1** (default, cost-effective)
- **OpenAI GPT-4o Mini**
- **Anthropic Claude-3.5-Sonnet**
- **Mistral Medium**
- **Google Gemini Pro**

### Example AI Output

```json
{
  "channel_id": "UC1234567890",
  "channel_name": "Finance Expert",
  "video_id": "abc123xyz456",
  "video_title": "Bitcoin Price Prediction 2025",
  "post_date": "2025-01-15",
  "language": "en",
  "transcript_summary": "The analyst discusses Bitcoin's potential trajectory...",
  "predictions": [
    {
      "asset": "BTC",
      "sentiment": "bullish",
      "prediction_text": "Bitcoin will reach $100,000 by end of 2025",
      "prediction_date": "2025-01-15",
      "horizon": {
        "type": "end_of_year",
        "value": "2025-12-31"
      },
      "target_price": 100000,
      "confidence": "high"
    }
  ],
  "ai_modifications": []
}
```

## 🔄 Detailed Workflow

### Main Processing Pipeline

1. **Application Startup**
   - Validate configuration using `validateConfig()`
   - Test connections to all external services (Supabase, YouTube, OpenRouter, RapidAPI)
   - Initialize `FinfluencerTracker` class with `CronJobStats`

2. **Channel Processing Phase**
   - Fetch active channels from `finfluencer_channels` table
   - Process each channel sequentially with 1-second delays
   - For each channel:
     - Get new videos since `last_checked_at`
     - Filter out live/premiere videos and videos < 60 seconds
     - Process each video individually

3. **Video Processing Phase**
   - Check if video already exists in database
   - Skip if already processed (increment `skipped_videos`)
   - Retrieve transcript using RapidAPI or fallback to YouTube Data API
   - **Validate transcript quality**:
     - Minimum 50 characters
     - Contains line breaks or sufficient word count
     - Must look like real captions/subtitles

4. **AI Analysis Phase**
   - Send validated transcript to OpenRouter for analysis
   - Parse structured JSON response
   - Extract predictions, sentiment, target prices, horizons

5. **Database Storage Phase**
   - Insert prediction record to `finfluencer_predictions`
   - Update channel `last_checked_at` timestamp
   - Increment success counters

6. **Idle-Time Retry Phase**
   - **After main processing completes**, trigger retry service
   - Process failed predictions in batches of 10
   - Apply 5-second delays between batches
   - Track retry statistics and logging

### Error Handling Strategy

- **Transcript Validation Failures**: Create fallback record with "No subtitles/captions available"
- **AI Analysis Failures**: Create basic record with error message, continue processing
- **Database Errors**: Log error but continue to next video
- **Retry Service Failures**: Log error but don't stop main application

## 🔄 Retry Service

The integrated retry service provides automatic recovery for failed predictions:

### Key Features

- **Smart Target Selection**: Processes records with empty predictions array
- **Intelligent Batch Processing**: 10 records per batch with 5-second delays
- **Maximum 3 Attempts**: Prevents infinite retry loops
- **Priority Processing**: Newer records processed first
- **Comprehensive Logging**: Detailed statistics and error tracking

### Retry Logic

1. **Target Selection**: Find records where `predictions = '[]'` and `retry_count < 3`
2. **Batch Processing**: Process 10 records at a time with delays
3. **Video Info Retrieval**: Get video information from RapidAPI
4. **Caption URL Selection**: Find best available caption URL (default language → English → any)
5. **Transcript Fetching**: Retrieve and parse YouTube JSON3 format
6. **AI Analysis**: Analyze recovered transcripts
7. **Database Update**: Update existing records with successful results

### Retry Statistics

The service provides comprehensive statistics:
- Total eligible records for retry
- Records that reached maximum attempts
- Success/failure rates per batch
- Detailed error reasons and patterns

## 🛡️ Error Handling

- **Retry Logic**: **Automatic retries with exponential backoff for failed predictions**
- **Graceful Degradation**: Creates basic records even if analysis fails
- **Rate Limiting**: Respects API quotas for YouTube, RapidAPI, and OpenRouter
- **Graceful Shutdown**: Handles SIGTERM/SIGINT signals properly
- **Validation**: Comprehensive input validation and sanitization
- **Timeout Protection**: Configurable timeouts for API calls
- **Error Isolation**: Retry failures don't stop the main processing pipeline

## 📊 Monitoring & Logging

The service provides comprehensive logging with `CronJobStats`:

- 🚀 **Startup**: Configuration validation and connection tests
- 📺 **Channel Processing**: Status per channel with video counts
- 📹 **Video Processing**: Individual video status and transcript validation
- 🔄 **Retry Service**: Statistics and batch processing details
- ✅ **Success/Failure Rates**: Detailed counts and percentages
- 📊 **Final Statistics**: Complete execution summary with memory usage
- ⚠️ **Error Details**: Stack traces and context information

### Log Levels

- `info`: General progress information and statistics
- `warn`: Non-fatal issues, retry failures, transcript validation warnings
- `error`: Fatal errors, complete retry failures, critical failures
- `debug`: Detailed debugging info for troubleshooting

### Statistics Tracking

The application tracks comprehensive statistics:
- Total/Processed/Skipped video counts
- Videos with/without captions
- Error counts and success rates
- Memory usage and execution duration
- Retry service statistics

## 🔧 Configuration Options

### OpenRouter Models

Easily switch AI models by changing `OPENROUTER_MODEL`:

- `deepseek/deepseek-chat-v3.1:free` (default)
- `openai/gpt-4o-mini`
- `anthropic/claude-3.5-sonnet`
- `mistralai/mistral-medium`
- `google/gemini-pro`

### Processing Limits

- `YOUTUBE_MAX_RESULTS`: Videos per API call (default: 50)
- `MAX_RETRIES`: Retry attempts (default: 3)
- `REQUEST_TIMEOUT`: API timeout in ms (default: 90000)
- `RAPIDAPI_MAX_POLL_TIME`: Maximum time to wait for transcript (default: 300000ms)

### Retry Service Configuration

- `MAX_RETRY_ATTEMPTS`: Maximum retry attempts per record (default: 3)
- `RETRY_BATCH_SIZE`: Records processed per batch (default: 10)
- `RETRY_DELAY_BETWEEN_BATCHES`: Delay between batches in ms (default: 5000)

## 📈 Performance

- **Memory Efficient**: Streams large transcripts, minimal memory footprint
- **Rate Limited**: Respects API quotas to avoid bans
- **Batch Processing**: Efficient database operations and retry processing
- **Container Optimized**: Small Alpine Linux base image
- **Adaptive Polling**: RapidAPI polling adapts to processing time
- **Idle-Time Processing**: Uses remaining processing time for recovery operations
- **Smart Validation**: Heuristic checks prevent unnecessary AI processing

## 🐛 Troubleshooting

### Common Issues

1. **YouTube API Quota Exceeded**
   - Check API quota in Google Cloud Console
   - Reduce `YOUTUBE_MAX_RESULTS` if needed

2. **RapidAPI Timeout**
   - Some videos take longer to process
   - Increase `RAPIDAPI_MAX_POLL_TIME` if needed
   - Check video has available transcripts

3. **Supabase Connection Failed**
   - Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
   - Check database table existence

4. **OpenRouter API Errors**
   - Verify `OPENROUTER_API_KEY`
   - Check model availability
   - Monitor rate limits

5. **Transcript Not Available**
   - Some videos don't have transcripts
   - Service logs warnings but continues processing
   - Check if video has closed captions enabled

6. **High Retry Rates**
   - Check RapidAPI connectivity
   - Verify AI analyzer functionality
   - Review network connectivity

7. **No Records Being Retried**
   - Check `predictions` field is truly empty array
   - Verify `retry_count < MAX_RETRY_ATTEMPTS`
   - Ensure records exist in database

8. **Database Schema Issues**
   - Verify all required columns exist in both tables
   - Check column types match the defined schema
   - Ensure proper indexing on frequently queried columns

### Debug Mode

Set `LOG_LEVEL=debug` for detailed logging:

```bash
LOG_LEVEL=debug npm run dev
```

### Health Check

The service includes comprehensive health checks:

```typescript
const health = await supabaseService.healthCheck();
// Returns database status, table existence, and basic statistics
```

### Retry Service Debug Commands

```typescript
// Get retry statistics
const stats = await retryService.getRetryStatistics();

// Process specific batch
await retryService.processFailedPredictions();
```

### Database Query Debugging

Monitor database operations through the health check endpoint and health check service methods.

## 📝 Development

### Adding New Features

1. **Add Types**: Update `src/types.ts` with new interfaces
2. **Implement Logic**: Create new service files in appropriate modules
3. **Error Handling**: Add error classes in `src/errors.ts`
4. **Update Configuration**: Modify `src/config.ts` for new settings
5. **Add Logging**: Use the logger utility throughout
6. **Update Retry Service**: Modify `src/retryService.ts` if needed

### Testing

```bash
npm run build
npm start
```

### Code Style

- TypeScript strict mode enabled
- Comprehensive error handling
- Detailed logging with context
- Modular architecture
- Integration testing for retry service

### Version Management

The project uses semantic versioning (v1.2.6):
- **Major**: Breaking changes
- **Minor**: New features, backwards compatible
- **Patch**: Bug fixes, backwards compatible

### Documentation Updates

- Update `README.md` for user-facing changes
- Update `src/version.ts` for version information

## 📚 Additional Documentation

### Enhanced Analyzer Features

The `enhancedAnalyzer.ts` provides advanced AI analysis capabilities with Supabase AI integration:

- **Multi-Model Support**: Seamless switching between OpenRouter and Supabase AI models
- **Contextual Analysis**: Enhanced prompt engineering for financial prediction accuracy
- **Error Correction**: Automatic validation and correction of AI-generated predictions
- **Batch Processing**: Efficient analysis of multiple transcripts with rate limiting

### Supabase AI Services

The `supadataService.ts` and `supadataRapidAPIService.ts` modules provide:

- **Supabase AI Integration**: Direct access to Supabase's AI inference capabilities
- **Vector Embeddings**: Advanced semantic analysis of financial content
- **Custom Prompts**: Tailored prompt templates for financial prediction extraction
- **Fallback Mechanisms**: Automatic fallback to OpenRouter when Supabase AI is unavailable

## 📄 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Update documentation
6. Submit a pull request

## 📞 Support

For issues and questions:

1. Check the troubleshooting section
2. Review the logs for error details
3. Verify environment variables
4. Check API service status
5. Consult the retry service documentation

## 🔄 Recent Updates (v1.2.6)

- ✨ **Enhanced Analyzer**: Advanced AI analysis with Supabase AI integration
- 🚀 **Supabase AI Services**: New modules for Supabase AI inference capabilities
- 🔧 **Multi-Model Support**: Seamless switching between OpenRouter and Supabase AI
- 📊 **Vector Embeddings**: Advanced semantic analysis for financial content
- 🎯 **Performance Optimizations**: Improved batch processing and rate limiting
- 🛡️ **Enhanced Error Handling**: Sophisticated retry logic with smart fallbacks
- 📈 **Advanced Statistics**: Comprehensive monitoring with memory usage tracking
- 🔄 **Intelligent Retry Service**: Automatic recovery with priority processing
- 🎨 **Next.js & Tailwind CSS**: Modern web framework integration for UI components
- 📝 **Updated Documentation**: Comprehensive guides for new features and services

---

**Built with ❤️ for automated financial analysis**
