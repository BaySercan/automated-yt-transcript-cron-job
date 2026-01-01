# Automated YouTube Transcript Generator v2.0.21

A Dockerized microservice designed to run as a daily cron job that analyzes YouTube "finfluencer" videos for financial predictions and saves structured results to Supabase.

## 🎯 Purpose

The cron job automatically:

1. Fetches active YouTube channel IDs from a Supabase table
2. Retrieves new videos since each channel's last check date (using optimized `playlistItems.list` API)
3. **Detects and processes any missed videos** (gap detection from START_DATE)
4. Downloads video transcripts using a **3-tier fallback system**
5. Validates transcript quality (minimum 50 characters, real captions)
6. Analyzes transcripts using AI models hosted on OpenRouter
7. Parses structured JSON output and saves to Supabase
8. **Automatically retries failed predictions during idle time**
9. **Fetches historical asset prices with persistent caching & multi-provider fallback**
10. **Verifies predictions against actual market data with strict horizon enforcement**
11. **Generates comprehensive run reports saved to database**
12. Runs nightly at 23:30 (Europe/Istanbul, UTC+3)

## ✨ Key Features

### Core Functionality

- **🔄 Intelligent Retry Service**: Automatic recovery mechanism for failed predictions
- **� Gap Detection**: Finds and processes videos missed during previous fetches
- **⚡ Optimized YouTube API**: Uses `playlistItems.list` (1 unit) instead of `search.list` (100 units)
- **�📊 Comprehensive Reporting**: Detailed JSON run reports saved to `run_reports` table
- **🖥️ Beautiful CLI**: Color-coded, table-formatted console output for local debugging
- **🤖 AI-Powered Analysis**: Multiple AI model support via OpenRouter
- **🛡️ Robust Error Handling**: Graceful degradation and recovery mechanisms
- **⚡ Performance Optimized**: Memory-efficient processing with adaptive polling
- **🎯 Transcript Validation**: Heuristic validation to ensure real captions/subtitles
- **♾️ Unlimited Processing**: All processes loop until ALL records are processed (no artificial limits)

### Transcript Fetching (3-Tier Fallback System)

The transcript generation system uses a resilient **3-tier architecture** with automatic failover:

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRANSCRIPT FETCHING                          │
├─────────────────────────────────────────────────────────────────┤
│  Tier 1: RapidAPI           (Primary - async 2-step process)   │
│    ↓ (on failure)                                               │
│  Tier 2: Supadata Direct    (Secondary - mixed sync/async)     │
│    ↓ (on failure)                                               │
│  Tier 3: TranscriptAPI.com  (Tertiary - simple GET request)    │
└─────────────────────────────────────────────────────────────────┘
```

**Protection Mechanisms:**

- **Circuit Breaker**: Stops calling failing services after 8 failures, auto-resets after 2 minutes
- **Rate Limiting**: Per-service rate limits with jitter to prevent thundering herd
- **Retry with Backoff**: Automatic retry with exponential backoff for transient failures
- **Adaptive Polling**: Starts fast (10s) and slows down (up to 60s) for long-running requests

### Price Data & Verification

- **💾 Persistent Price Cache**:
  - `asset_prices` table stores all fetched prices to minimize API costs
  - Batch saving mechanism for high-performance caching
  - Intelligent cache invalidation and source tracking
- **💰 Multi-Provider Price Fetching**:
  - **Primary**: Yahoo Finance (with 3-day window for timezone handling)
  - **Fallback**: Stooq.com (with automatic retry on previous days)
  - **Crypto**: CoinMarketCap (current) + CoinGecko (historical)
  - **Special**: Twelve Data (XAUTRYG - Gram Gold/TRY)
  - **Last Resort**: Google Finance (current prices only)
- **🎯 Smart Verification**:

  - **Target Price Priority**: Checks specific price targets first
  - **Sentiment Thresholds**: Asset-type-specific percentage requirements
  - **Horizon Enforcement**: Explicitly marks predictions as "Wrong" if horizon date passes without target validation

- **🌍 International Market Support**:
  - **BIST 100** (Istanbul): `XU100.IS` (Yahoo) → `^xutry` (Stooq)
  - **US Markets**: S&P 500, NASDAQ, Dow Jones
  - **European Markets**: DAX, FTSE
  - **Asian Markets**: Nikkei
  - **Crypto**: All major cryptocurrencies
  - **Commodities**: Gold, Silver, Oil
  - **Forex**: Major currency pairs

## 🛠️ Tech Stack

- **Language**: TypeScript (Node.js 20+)
- **Framework**: Next.js 14+ (for web interface components)
- **Styling**: Tailwind CSS (utility-first CSS framework)
- **Scheduler**: Northflank Cron Job (daily at 23:30)
- **Database**: Supabase (PostgreSQL)
- **AI Provider**: OpenRouter API (for transcript analysis)
- **Transcript APIs**: RapidAPI, Supadata, TranscriptAPI.com
- **Price APIs**: Yahoo Finance, Twelve Data, Stooq, CoinMarketCap, CoinGecko, Google Finance
- **Deployment**: Docker
- **Configuration**: Environment variables

## 📁 Project Structure

```bash
/src
 ├─ index.ts                     # Main FinfluencerTracker class with cron logic
 ├─ youtube.ts                   # YouTube service with 3-tier transcript fallback
 ├─ rapidapi.ts                  # RapidAPI transcript service (Tier 1)
 ├─ supadataService.ts           # Supadata Direct service (Tier 2)
 ├─ enhancedAnalyzer.ts          # AI analysis using OpenRouter
 ├─ supabase.ts                  # Database operations and health checks
 ├─ types.ts                     # TypeScript interfaces and types
 ├─ utils.ts                     # Rate limiting, circuit breaker, utilities
 ├─ config.ts                    # Environment configuration and validation
 ├─ retryService.ts              # Automatic retry service for failed predictions
 ├─ combinedPredictionsService.ts # Combines predictions, fetches prices, verification
 ├─ predictionChecker.ts         # Prediction verification against market data
 ├─ /services
 │  ├─ transcriptAPIService.ts   # TranscriptAPI.com service (Tier 3)
 │  ├─ reportingService.ts       # Centralized statistics and reporting
 │  ├─ priceService.ts           # Multi-provider price fetching with persistent cache
 │  ├─ yahooService.ts           # Yahoo Finance integration (3-day window)
 │  ├─ twelveDataService.ts      # Twelve Data integration (XAUTRYG)
 │  ├─ stooqService.ts           # Stooq.com fallback service (retry logic)
 │  └─ usagoldService.ts         # USAGOLD integration for precious metals
 └─ version.ts                   # Version management and build information
```

## 🗄️ Database Schema

### Table 1 — `finfluencer_channels`

Stores active YouTube channels to monitor.

### Table 2 — `finfluencer_predictions`

Raw prediction data extracted from video transcripts.

### Table 3 — `combined_predictions`

Enhanced prediction table with market data, normalized assets, and verification status.

### Table 4 — `run_reports`

Comprehensive execution logs replacing legacy function_logs.

| Column      | Type      | Description                    |
| ----------- | --------- | ------------------------------ |
| id          | uuid (pk) | Auto-generated UUID            |
| run_id      | text      | Unique run identifier          |
| started_at  | timestamp | Run start time                 |
| finished_at | timestamp | Run end time                   |
| duration_ms | integer   | Total duration in milliseconds |
| status      | varchar   | success, partial, failed       |
| report      | jsonb     | Full hierarchical JSON report  |

### Table 5 — `asset_prices`

Persistent price cache to reduce external API dependence.

| Column   | Type      | Description         |
| -------- | --------- | ------------------- |
| asset    | text (pk) | Asset symbol        |
| date     | date (pk) | Price date          |
| price    | numeric   | Closing price       |
| currency | text      | Currency code (USD) |
| source   | text      | Source (yahoo, etc) |

## 💰 Price Fetching & Caching Strategy

The service now uses a **Persistent Cache Strategy**:

1. **Check `asset_prices` Table**: First, check if we already have the price for this asset/date in Supabase.
2. **Memory Cache**: Check in-memory Map for very recently fetched prices.
3. **External API**: If not found, fetch from external providers (Yahoo, Stooq, etc.).
4. **Save to Cache**: Successfully fetched prices are saved to `asset_prices` for future use (forever).

## 🔄 Recent Updates

### v2.0.19 - API Optimization & Complete Processing

- ✅ **YouTube API Optimization**: Uses `playlistItems.list` (1 unit) instead of `search.list` (100 units) - **99% cost reduction**
- ✅ **Unlimited Processing**: All processes now run without artificial limits:
  - Combined predictions: Loops until ALL records processed (batches of 500)
  - Prediction verification: Loops until ALL horizon-passed predictions verified
  - Retry service: Processes ALL pending records
- ✅ **Gap Detection**: New `detectAndProcessMissedVideos()` finds and processes videos missed in previous runs
  - Compares YouTube videos (since START_DATE) with database
  - Automatically catches videos skipped due to rate limits, network issues, etc.
- ✅ **Early Stopping**: YouTube video fetching stops when hitting videos older than cutoff date
- ✅ **Automatic Fallback**: Falls back to `search.list` if `playlistItems.list` fails

### v2.0.18 - Transcript System Improvements

- ✅ **NEW: TranscriptAPI.com Integration**: Added as Tier 3 in fallback chain
- ✅ **Circuit Breaker Pattern**: Properly implemented across all transcript services
- ✅ **Optimized Polling**: RapidAPI polling now starts at 10s (was 30s) for faster responses
- ✅ **Retry with Backoff**: TranscriptAPI now retries up to 3x on transient failures
- ✅ **Rate Limit Monitoring**: Added `RateLimitMonitor` across all transcript services
- ✅ **Graceful Shutdown**: Now logs TranscriptAPI credit stats on shutdown
- ✅ **Removed**: supadataRapidAPIService (consolidated into Supadata Direct)

### v2.0.17 - Statistics & Reporting

- ✅ **New Reporting System**: Replaced `CronJobStats` with `ReportingService` and `run_reports` table
- ✅ **Persistent Price Cache**: Implemented `asset_prices` table to minimize API calls
- ✅ **Strict Verification**: Correctly marks predictions as `wrong` if horizon passes

### v2.0.3 - Price Fetching & Verification

- ✅ **Stooq Fallback**: Added Stooq.com as fallback price source
- ✅ **Twelve Data Integration**: Dedicated source for Turkish Gram Gold (XAUTRYG)
- ✅ **BIST 100 Support**: Full support for Istanbul Stock Exchange
- ✅ **3-Day Window**: Yahoo Finance now uses 3-day window for reliability

## ⚙️ Environment Variables

### Required

| Variable                    | Description                        |
| --------------------------- | ---------------------------------- |
| `SUPABASE_URL`              | Supabase project URL               |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key          |
| `YOUTUBE_API_KEY`           | YouTube Data API v3 key            |
| `OPENROUTER_API_KEY`        | OpenRouter API key for AI analysis |

### Transcript Services (at least one required)

| Variable                    | Description                                  |
| --------------------------- | -------------------------------------------- |
| `RAPIDAPI_KEY`              | RapidAPI key for transcript service (Tier 1) |
| `SUPADATA_API_KEY`          | Supadata API key (Tier 2)                    |
| `TRANSCRIPTAPI_COM_API_KEY` | TranscriptAPI.com API key (Tier 3)           |

### Optional

| Variable                    | Description         | Default                          |
| --------------------------- | ------------------- | -------------------------------- |
| `AI_MODEL_1`                | Primary AI model    | `deepseek/deepseek-chat-v3-0324` |
| `TRANSCRIPTAPI_RATE_LIMIT`  | Requests per second | `0.5`                            |
| `TRANSCRIPTAPI_MAX_RETRIES` | Max retry attempts  | `3`                              |

---

**Built with ❤️ for automated financial analysis**
