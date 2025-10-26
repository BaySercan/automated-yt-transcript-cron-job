# Finfluencer Tracker Cron Job v4

A Dockerized microservice designed to run as a daily cron job that analyzes YouTube "finfluencer" videos for financial predictions and saves structured results to Supabase.

## 🎯 Purpose

The cron job automatically:

1. Fetches active YouTube channel IDs from a Supabase table
2. Retrieves new videos since each channel's last check date
3. Downloads video transcripts
4. Analyzes transcripts using AI models hosted on OpenRouter
5. Parses structured JSON output and saves to Supabase
6. Updates channel processing timestamps
7. Runs nightly at 23:30 (Europe/Istanbul, UTC+3)

## 🛠️ Tech Stack

- **Language**: TypeScript (Node.js 20+)
- **Scheduler**: Northflank Cron Job (daily at 23:30)
- **Database**: Supabase (PostgreSQL)
- **AI Provider**: OpenRouter API
- **YouTube API**: YouTube Data API v3
- **Transcript**: `youtube-transcript` package
- **Deployment**: Docker
- **Configuration**: Environment variables

## 📁 Project Structure

```
/src
 ├─ index.ts             # Entry point: main cron logic
 ├─ youtube.ts           # YouTube fetch and transcript utilities
 ├─ analyzer.ts          # Sends transcript to OpenRouter, parses response
 ├─ supabase.ts          # Handles database read/write
 ├─ types.ts             # Shared TypeScript interfaces
 ├─ utils.ts             # Logging, retries, JSON validation, etc.
 ├─ config.ts            # Environment configuration
 └─ errors.ts            # Custom error classes
Dockerfile
.env.example
package.json
tsconfig.json
README.md
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
OPENROUTER_MODEL=openai/gpt-4o-mini

# Application Configuration
START_DATE=2025-01-01
TZ=Europe/Istanbul

# Logging Configuration
LOG_LEVEL=info
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

| Column             | Type      | Description               |
| ------------------ | --------- | ------------------------- |
| id                 | uuid (pk) | Auto                      |
| channel_id         | text      | YouTube channel ID        |
| channel_name       | text      | Channel name              |
| video_id           | text      | YouTube video ID          |
| video_title        | text      | Video title               |
| post_date          | date      | Video publish date        |
| language           | text      | Detected language         |
| transcript_summary | text      | Summary of content        |
| predictions        | jsonb     | JSON array of predictions |
| ai_modifications   | jsonb     | JSON corrections (if any) |
| created_at         | timestamp | Default now()             |

## 🚀 Installation & Setup

### 1. Clone and Install Dependencies

```bash
git clone <repository-url>
cd finfluencer-tracker
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
docker build -t finfluencer-tracker .
```

### Run with Environment File

```bash
docker run --env-file .env finfluencer-tracker
```

### Run in Background

```bash
docker run -d --name finfluencer-tracker --env-file .env finfluencer-tracker
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
- Any errors

## 🧠 AI Analysis

The service uses a detailed prompt to extract financial predictions from video transcripts. The AI analyzes:

- **Asset predictions** (BTC, GOLD, AAPL, BIST, NASDAQ, S&P500, etc.)
- **Future-oriented statements** (price forecasts, market direction)
- **Time horizons** (exact dates, end of year, quarters, etc.)
- **Sentiment analysis** (bullish, bearish, neutral)
- **Target prices** with automatic error correction
- **Confidence levels** (low, medium, high)

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

## 📊 Monitoring & Logging

The service provides comprehensive logging:

- 🚀 Startup and connection tests
- 📺 Channel processing status
- 📹 Video fetching and analysis
- ✅ Success/failure rates
- 📊 Final statistics summary
- 🧠 Memory usage tracking
- ⚠️ Error details and stack traces

### Log Levels

- `info`: General progress information
- `warn`: Non-fatal issues
- `error`: Fatal errors
- `debug`: Detailed debugging info

## 🔄 Workflow

1. **Startup**: Validate configuration and test connections
2. **Channel Fetch**: Get all active channels from Supabase
3. **Video Discovery**: For each channel, find new videos since last check
4. **Transcript Processing**: Download transcripts for new videos
5. **AI Analysis**: Send transcripts to OpenRouter for analysis
6. **Data Storage**: Save structured results to Supabase
7. **Cleanup**: Update timestamps and log statistics

## 🛡️ Error Handling

- **Retry Logic**: Automatic retries with exponential backoff
- **Graceful Degradation**: Creates basic records even if analysis fails
- **Rate Limiting**: Respects API quotas for YouTube and OpenRouter
- **Graceful Shutdown**: Handles SIGTERM/SIGINT signals properly
- **Validation**: Comprehensive input validation and sanitization

## 🔧 Configuration Options

### OpenRouter Models

Easily switch AI models by changing `OPENROUTER_MODEL`:

- `openai/gpt-4o-mini` (default)
- `anthropic/claude-3.5-sonnet`
- `mistralai/mistral-medium`
- `google/gemini-pro`

### Processing Limits

- `YOUTUBE_MAX_RESULTS`: Videos per API call (default: 50)
- `MAX_RETRIES`: Retry attempts (default: 3)
- `REQUEST_TIMEOUT`: API timeout in ms (default: 30000)

## 📈 Performance

- **Memory Efficient**: Streams large transcripts, minimal memory footprint
- **Rate Limited**: Respects API quotas to avoid bans
- **Batch Processing**: Efficient database operations
- **Container Optimized**: Small Alpine Linux base image

## 🐛 Troubleshooting

### Common Issues

1. **YouTube API Quota Exceeded**
   - Check API quota in Google Cloud Console
   - Reduce `YOUTUBE_MAX_RESULTS` if needed

2. **Supabase Connection Failed**
   - Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
   - Check database table existence

3. **OpenRouter API Errors**
   - Verify `OPENROUTER_API_KEY`
   - Check model availability
   - Monitor rate limits

4. **Transcript Not Available**
   - Some videos don't have transcripts
   - Service logs warnings but continues processing

### Debug Mode

Set `LOG_LEVEL=debug` for detailed logging:

```bash
LOG_LEVEL=debug npm run dev
```

## 📝 Development

### Adding New Features

1. Add types in `src/types.ts`
2. Implement logic in appropriate service file
3. Add error handling in `src/errors.ts`
4. Update configuration in `src/config.ts`
5. Add logging with the logger utility

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

## 📄 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📞 Support

For issues and questions:

1. Check the troubleshooting section
2. Review the logs for error details
3. Verify environment variables
4. Check API service status

---

**Built with ❤️ for automated financial analysis**
