# Automated YouTube Transcript Generator v1.1.12

A Dockerized microservice designed to run as a daily cron job that analyzes YouTube "finfluencer" videos for financial predictions and saves structured results to Supabase.

## 🎯 Purpose

The cron job automatically:

1. Fetches active YouTube channel IDs from a Supabase table
2. Retrieves new videos since each channel's last check date
3. Downloads video transcripts using RapidAPI
4. Analyzes transcripts using AI models hosted on OpenRouter
5. Parses structured JSON output and saves to Supabase
6. **Automatically retries failed predictions during idle time**
7. Updates channel processing timestamps
8. Runs nightly at 23:30 (Europe/Istanbul, UTC+3)

## ✨ Key Features

- **🔄 Intelligent Retry Service**: Automatic recovery mechanism for failed predictions
- **📊 Batch Processing**: Efficient processing with rate limiting and error isolation
- **🤖 AI-Powered Analysis**: Multiple AI model support via OpenRouter
- **📝 Real-time Logging**: Comprehensive monitoring and statistics
- **🛡️ Robust Error Handling**: Graceful degradation and recovery mechanisms
- **⚡ Performance Optimized**: Memory-efficient processing with adaptive polling

## 🛠️ Tech Stack

- **Language**: TypeScript (Node.js 20+)
- **Scheduler**: Northflank Cron Job (daily at 23:30)
- **Database**: Supabase (PostgreSQL)
- **AI Provider**: OpenRouter API (for transcript analysis)
- **YouTube API**: YouTube Data API v3 + RapidAPI (for transcript retrieval)
- **Transcript Provider**: RapidAPI (youtube-multi-api service)
- **Deployment**: Docker
- **Configuration**: Environment variables

## 📁 Project Structure

```
/src
 ├─ index.ts             # Entry point: main cron logic
 ├─ youtube.ts           # YouTube fetch utilities
 ├─ rapidapi.ts          # RapidAPI transcript service
 ├─ analyzer.ts          # Sends transcript to OpenRouter, parses response
 ├─ supabase.ts          # Handles database read/write
 ├─ types.ts             # Shared TypeScript interfaces
 ├─ utils.ts             # Logging, retries, JSON validation, etc.
 ├─ config.ts            # Environment configuration
 ├─ errors.ts            # Custom error classes
 ├─ retryService.ts      # Automatic retry service for failed predictions
 ├─ jsonUtils.ts         # JSON validation and parsing utilities
 └─ version.ts           # Version information and utilities
Dockerfile
.env.example
package.json
tsconfig.json
README.md
retry-service-documentation.md
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

## 🗄️ Database Schema

### Table 1 — `finfluencer_channels`

| Column          | Type      | Description                     |
| --------------- | --------- | ------------------------------- |
| id              | uuid (pk) | Auto                            |
| channel_id      | text      | YouTube channel ID              |
| channel_name    | text      | Channel's display name          |
| is_active       | boolean   | Whether to include this channel |
| last_checked_at | timestamp | Date last processed             |
| added_at        | timestamp | Default now()                   |

### Table 2 — `finfluencer_predictions`

| Column             | Type      | Description                       |
| ------------------ | --------- | --------------------------------- |
| id                 | uuid (pk) | Auto                              |
| channel_id         | text      | YouTube channel ID                |
| channel_name       | text      | Channel name                      |
| video_id           | text      | YouTube video ID                  |
| video_title        | text      | Video title                       |
| post_date          | date      | Video publish date                |
| language           | text      | Detected language                 |
| transcript_summary | text      | Summary of content                |
| predictions        | jsonb     | JSON array of predictions         |
| ai_modifications   | jsonb     | JSON corrections (if any)         |
| **retry_count**    | integer   | **Number of retry attempts (0-3)**|
| **last_retry_at**  | timestamp | **Last retry attempt timestamp**  |
| **retry_reason**   | text      | **Error message from failures**   |
| created_at         | timestamp | Default now()                     |

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

## 🐳 Docker Deployment

### Build Docker Image

```bash
docker build -t finfluencer-tracker:v1.1.12 .
```

### Run with Environment File

```bash
docker run --env-file .env finfluencer-tracker:v1.1.12
```

### Run in Background

```bash
docker run -d --name finfluencer-tracker --env-file .env finfluencer-tracker:v1.1.12
```

### Update to Latest Version

```bash
update-docker-versioned.ps1
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

## 🔄 Workflow

1. **Startup**: Validate configuration and test connections
2. **Channel Fetch**: Get all active channels from Supabase
3. **Video Discovery**: For each channel, find new videos since last check
4. **Transcript Processing**: Download transcripts using RapidAPI
5. **AI Analysis**: Send transcripts to OpenRouter for analysis
6. **Data Storage**: Save structured results to Supabase
7. **Idle-Time Retry**: **Process failed predictions automatically**
8. **Cleanup**: Update timestamps and log statistics

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

The service provides comprehensive logging:

- 🚀 Startup and connection tests
- 📺 Channel processing status
- 📹 Video fetching and analysis
- 🔄 **Retry service statistics and batch processing**
- ✅ Success/failure rates
- 📊 Final statistics summary
- 🧠 Memory usage tracking
- ⚠️ Error details and stack traces

### Log Levels

- `info`: General progress information
- `warn`: Non-fatal issues, retry failures
- `error`: Fatal errors, complete retry failures
- `debug`: Detailed debugging info

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

6. **High Retry Rates**
   - Check RapidAPI connectivity
   - Verify AI analyzer functionality
   - Review network connectivity

7. **No Records Being Retried**
   - Check `predictions` field is truly empty array
   - Verify `retry_count < MAX_RETRY_ATTEMPTS`
   - Ensure records exist in database

### Debug Mode

Set `LOG_LEVEL=debug` for detailed logging:

```bash
LOG_LEVEL=debug npm run dev
```

### Retry Service Debug Commands

```typescript
// Get retry statistics
const stats = await retryService.getRetryStatistics();

// Process specific batch
await retryService.processFailedPredictions();
```

## 📝 Development

### Adding New Features

1. Add types in `src/types.ts`
2. Implement logic in appropriate service file
3. Add error handling in `src/errors.ts`
4. Update configuration in `src/config.ts`
5. Add logging with the logger utility
6. **Update retry service logic if needed in `src/retryService.ts`**

### Testing

```bash
npm run build
npm start
```

### Code Style

- TypeScript strict mode enabled
- Comprehensive error handling
- Detailed logging
- Modular architecture
- **Retry service integration testing**

### Version Management

The project uses semantic versioning (v1.1.12):
- **Major**: Breaking changes
- **Minor**: New features, backwards compatible
- **Patch**: Bug fixes, backwards compatible

### Documentation Updates

- Update `README.md` for user-facing changes
- Update `retry-service-documentation.md` for retry service changes
- Update `src/version.ts` for version information

## 📚 Additional Documentation

- **[Retry Service Documentation](retry-service-documentation.md)**: Detailed documentation about the retry service implementation, configuration, and troubleshooting

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

## 🔄 Recent Updates (v1.1.12)

- ✨ **New Retry Service**: Automatic recovery mechanism for failed predictions
- 📊 **Enhanced Error Handling**: Sophisticated retry logic with batch processing
- 🔧 **Configuration Updates**: New retry-related environment variables
- 📝 **Documentation**: Comprehensive retry service documentation
- 🎯 **Performance Improvements**: Idle-time processing optimization
- 🐛 **Bug Fixes**: Various stability improvements

---

**Built with ❤️ for automated financial analysis**
