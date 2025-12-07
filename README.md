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
8. **Fetches historical asset prices with multi-provider fallback**
9. **Verifies predictions against actual market data**
10. Updates channel processing timestamps
11. Runs nightly at 23:30 (Europe/Istanbul, UTC+3)

## ✨ Key Features

### Core Functionality
- **🔄 Intelligent Retry Service**: Automatic recovery mechanism for failed predictions
- **📊 Batch Processing**: Efficient processing with rate limiting and error isolation
- **🤖 AI-Powered Analysis**: Multiple AI model support via OpenRouter
- **📝 Real-time Logging**: Comprehensive monitoring and statistics with CronJobStats
- **🛡️ Robust Error Handling**: Graceful degradation and recovery mechanisms
- **⚡ Performance Optimized**: Memory-efficient processing with adaptive polling
- **🎯 Transcript Validation**: Heuristic validation to ensure real captions/subtitles

### Price Data & Verification
- **💰 Multi-Provider Price Fetching**:
  - **Primary**: Yahoo Finance (with 3-day window for timezone handling)
  - **Fallback**: Stooq.com (with automatic retry on previous days)
  - **Crypto**: CoinMarketCap (current) + CoinGecko (historical)
  - **Last Resort**: Google Finance (current prices only)

- **🎯 Smart Verification**:
  - **Target Price Priority**: Checks specific price targets first
  - **Sentiment Thresholds**: Asset-type-specific percentage requirements
    - Crypto: +10% (bullish) / -5% (bearish)
    - Stocks: +5% (bullish) / -5% (bearish)
    - Forex: +1% (bullish) / -1% (bearish)
    - Commodities/Indices: +3% (bullish) / -3% (bearish)
  
- **🌍 International Market Support**:
  - **BIST 100** (Istanbul): `XU100.IS` (Yahoo) → `^xutry` (Stooq)
  - **US Markets**: S&P 500, NASDAQ, Dow Jones
  - **European Markets**: DAX, FTSE
  - **Asian Markets**: Nikkei
  - **Crypto**: All major cryptocurrencies
  - **Commodities**: Gold, Silver, Oil
  - **Forex**: Major currency pairs

- **📈 Historical Data Reliability**:
  - 3-day window fetching for Yahoo Finance (handles timezone differences)
  - Automatic retry on previous days for Stooq (handles data gaps)
  - Asset type inference when AI classification fails
  - Entry price backfill for missing data

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
- **Price APIs**: 
  - Yahoo Finance (stocks, indices, commodities, forex)
  - Stooq.com (fallback for historical data)
  - CoinMarketCap (current crypto prices)
  - CoinGecko (historical crypto prices)
  - Google Finance (fallback for current prices)
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
 ├─ types.ts                     # TypeScript interfaces and types
 ├─ utils.ts                     # Logging, retries, JSON validation, utilities
 ├─ config.ts                    # Environment configuration and validation
 ├─ errors.ts                    # Custom error classes
 ├─ retryService.ts              # Automatic retry service for failed predictions
 ├─ combinedPredictionsService.ts # Combines predictions, fetches prices, verification
 ├─ predictionChecker.ts         # Prediction verification against market data
 ├─ /services
 │  ├─ priceService.ts           # Multi-provider price fetching with fallbacks
 │  ├─ yahooService.ts           # Yahoo Finance integration (3-day window)
 │  └─ stooqService.ts           # Stooq.com fallback service (retry logic)
 └─ version.ts                   # Version management and build information
```

## 🗄️ Database Schema

### Table 1 — `finfluencer_channels`

| Column                   | Type      | Description                     |
| ------------------------ | --------- | ------------------------------- |
| id                       | uuid (pk) | Auto-generated UUID             |
| channel_id               | text      | YouTube channel ID              |
| channel_name             | text      | Channel's display name          |
| is_active                | boolean   | Whether to include this channel |
| last_checked_at          | timestamp | Date last processed             |
| channel_info_update_date | timestamp | Last channel metadata refresh   |
| added_at                 | timestamp | Default now()                   |

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

### Table 3 — `combined_predictions`

Enhanced prediction table with market data and verification:

| Column                  | Type      | Description                                     |
| ----------------------- | --------- | ----------------------------------------------- |
| id                      | uuid (pk) | Auto-generated UUID                             |
| video_id                | text      | YouTube video ID                                |
| channel_id              | text      | YouTube channel ID                              |
| channel_name            | text      | Channel name                                    |
| post_date               | date      | Video publish date                              |
| asset                   | text      | Asset name (BTC, AAPL, BIST100, etc.)          |
| asset_type              | varchar   | crypto, stock, forex, commodity, index          |
| asset_entry_price       | numeric   | Historical price at post date                   |
| target_price            | numeric   | Target price if specified                       |
| sentiment               | varchar   | bullish, bearish, neutral                       |
| confidence              | varchar   | low, medium, high                               |
| horizon_value           | text      | Horizon description                             |
| horizon_type            | varchar   | exact, month, quarter, end_of_year, custom      |
| horizon_start_date      | timestamp | Start of verification window                    |
| horizon_end_date        | timestamp | End of verification window                      |
| status                  | varchar   | pending, correct, wrong                         |
| actual_price            | numeric   | Price at verification                           |
| resolved_at             | timestamp | When verification was performed                 |
| verification_metadata   | jsonb     | Verification details and source                 |
| prediction_text         | text      | Full prediction text                            |
| created_at              | timestamp | Record creation time                            |
| updated_at              | timestamp | Last update time                                |

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

# Price API Keys
COINGECKO_API_KEY=your_coingecko_api_key_here  # For historical crypto
CMC_PRO_API_KEY=your_coinmarketcap_api_key_here  # For current crypto

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

## 💰 Price Fetching Strategy

The service uses a sophisticated multi-provider fallback system:

### Fetch Priority

1. **Crypto Assets**:
   - Current: CoinMarketCap API
   - Historical: CoinGecko API
   
2. **Stocks, Indices, Commodities**:
   - Primary: Yahoo Finance (3-day window for reliability)
   - Fallback: Stooq.com (with retry on previous days)
   - Last Resort: Google Finance (current prices only)

### Yahoo Finance Enhancement

**Problem**: Yahoo returns empty data for some indices (BIST100, DAX) due to timezone/market hour issues.

**Solution**: Fetch a 3-day window (`date-1` to `date+2`) and filter locally for the correct candle.

```typescript
// Example: Fetch BIST100 for 2023-01-03
period1 = 2023-01-02 00:00 UTC  // -1 day
period2 = 2023-01-05 00:00 UTC  // +2 days
// Then filter for candle matching 2023-01-03
```

### Stooq Retry Logic

**Problem**: Stooq has data gaps for certain assets (especially BIST indices).

**Solution**: Automatically retry up to 3 previous days if the target date has no data.

```typescript
// Example: Request 2023-01-01 (Sunday - no data)
// Retry 1: 2022-12-31 (Saturday - no data)
// Retry 2: 2022-12-30 (Friday - found!)
```

### Symbol Normalization

| Asset         | Yahoo Symbol | Stooq Symbol |
| ------------- | ------------ | ------------ |
| BIST 100      | `XU100.IS`   | `^xutry`     |
| S&P 500       | `^GSPC`      | `^gspc`      |
| NASDAQ        | `^IXIC`      | `^ixic`      |
| Apple         | `AAPL`       | `aapl.us`    |
| Gold Futures  | `GC=F`       | `gc.f`       |
| EUR/USD       | `EURUSD=X`   | `eurusd`     |

## 🎯 Prediction Verification

### Verification Logic

1. **Target Price Check** (Priority):
   - If `target_price` exists, check if actual price met/exceeded target
   - Bullish: `actual_price >= target_price`
   - Bearish: `actual_price <= target_price`

2. **Sentiment Threshold Check** (Fallback):
   - If no target price, use asset-type-specific thresholds:

| Asset Type        | Bullish Threshold | Bearish Threshold |
| ----------------- | ----------------- | ----------------- |
| Crypto            | +10%              | -5%               |
| Stock             | +5%               | -5%               |
| Forex             | +1%               | -1%               |
| Commodity / Index | +3%               | -3%               |

### Example Scenarios

**Scenario 1: Target Price (Priority)**
```
Asset: BTC
Entry: $100
Target: $110
Actual: $105
Sentiment: Bullish
Result: WRONG (did not hit $110 target)
```

**Scenario 2: Sentiment Threshold (Crypto)**
```
Asset: BTC
Entry: $100
Target: null
Actual: $109
Sentiment: Bullish
Result: WRONG (did not reach +10% = $110)
```

**Scenario 3: Sentiment Threshold (Stock)**
```
Asset: AAPL
Entry: $100
Target: null
Actual: $105
Sentiment: Bullish
Result: CORRECT (reached +5% = $105)
```

## 🔄 Detailed Workflow

### Main Processing Pipeline

1. **Application Startup**
   - Validate configuration using `validateConfig()`
   - Test connections to all external services (Supabase, YouTube, OpenRouter, RapidAPI)
   - Initialize `FinfluencerTracker` class with `CronJobStats`

2. **Channel Processing Phase**
   - Fetch active channels from `finfluencer_channels` table
   - Update channel metadata (subscribers, views, etc.)
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
   - **Infer asset type** if AI doesn't classify it

5. **Price Fetching Phase**
   - For each prediction, fetch historical entry price
   - Use multi-provider fallback (Yahoo → Stooq → Google)
   - Store asset type and entry price in database

6. **Database Storage Phase**
   - Insert prediction record to `finfluencer_predictions`
   - Create enriched record in `combined_predictions`
   - Update channel `last_checked_at` timestamp
   - Increment success counters

7. **Verification Phase**
   - For predictions past their horizon date:
   - Calculate horizon date range based on type
   - Fetch prices across the verification window
   - Apply target price check or sentiment thresholds
   - Update status (correct/wrong) and actual price

8. **Idle-Time Retry Phase**
   - **After main processing completes**, trigger retry service
   - Process failed predictions in batches of 10
   - **Backfill missing entry prices** using retry logic
   - Apply 5-second delays between batches
   - Track retry statistics and logging

## 🛡️ Error Handling

- **Retry Logic**: **Automatic retries with exponential backoff for failed predictions**
- **Graceful Degradation**: Creates basic records even if analysis fails
- **Rate Limiting**: Respects API quotas for YouTube, RapidAPI, and OpenRouter
- **Graceful Shutdown**: Handles SIGTERM/SIGINT signals properly
- **Validation**: Comprehensive input validation and sanitization
- **Timeout Protection**: Configurable timeouts for API calls
- **Error Isolation**: Retry failures don't stop the main processing pipeline
- **Floating Point Tolerance**: Handles precision issues in threshold calculations

## 📊 Monitoring & Logging

The service provides comprehensive logging with `CronJobStats`:

- 🚀 **Startup**: Configuration validation and connection tests
- 📺 **Channel Processing**: Status per channel with video counts
- 📹 **Video Processing**: Individual video status and transcript validation
- 💰 **Price Fetching**: Success/failure rates per provider
- 🎯 **Verification**: Prediction accuracy and threshold checks
- 🔄 **Retry Service**: Statistics and batch processing details
- ✅ **Success/Failure Rates**: Detailed counts and percentages
- 📊 **Final Statistics**: Complete execution summary with memory usage
- ⚠️ **Error Details**: Stack traces and context information

### Log Levels

- `info`: General progress information and statistics
- `warn`: Non-fatal issues, retry failures, transcript validation warnings
- `error`: Fatal errors, complete retry failures, critical failures
- `debug`: Detailed debugging info for troubleshooting

## 🐛 Troubleshooting

### Common Issues

1. **Yahoo Finance Returns No Data**
   - The 3-day window should resolve this
   - Check if asset has Yahoo symbol mapping
   - Verify date is within market history

2. **Stooq Returns No Data**
   - The retry logic should handle this
   - Some assets may not be available on Stooq
   - Check Stooq symbol normalization

3. **Missing Entry Prices**
   - Run the retry service to backfill:
     ```typescript
     await combinedPredictionsService.retryMissingEntryPrices(50, false);
     ```
   - Check if asset type was inferred correctly
   - Verify price API keys are configured

4. **Incorrect Verification Status**
   - Check if target price exists (takes priority)
   - Verify sentiment threshold for asset type
   - Review horizon date calculation

5. **BIST 100 Not Found**
   - Ensure mapping: `XU100.IS` (Yahoo) → `^xutry` (Stooq)
   - Check if symbol is in `SPECIAL_SYMBOLS` mapping

### Debug Mode

Set `LOG_LEVEL=debug` for detailed logging:

```bash
LOG_LEVEL=debug npm run dev
```

## 📝 Development

### Adding New Asset Types

1. Update `SPECIAL_SYMBOLS` in `src/services/priceService.ts`
2. Add Stooq normalization in `src/services/stooqService.ts`
3. Update `inferAssetType` in `src/combinedPredictionsService.ts`
4. Add sentiment threshold in `checkHit` method

### Testing Price Fetching

```typescript
import { priceService } from './services/priceService';

// Test fetching
const price = await priceService.searchPrice('AAPL', new Date('2023-01-03'), 'stock');
console.log('Price:', price);
```

## 🔄 Recent Updates (v1.2.6)

### Price Fetching & Verification
- ✅ **Stooq Fallback**: Added Stooq.com as fallback price source
- ✅ **BIST 100 Support**: Full support for Istanbul Stock Exchange (XU100.IS → ^xutry)
- ✅ **3-Day Window**: Yahoo Finance now uses 3-day window for reliability
- ✅ **Retry Logic**: Stooq automatically retries previous days for missing data
- ✅ **Asset Type Inference**: Automatic classification when AI fails
- ✅ **Entry Price Backfill**: Retry mechanism for missing historical prices
- ✅ **Sentiment Thresholds**: Asset-type-specific percentage requirements
- ✅ **Target Price Priority**: Verification checks target before sentiment
- ✅ **Floating Point Fix**: Proper tolerance for threshold comparisons

### Database & Schema
- ✅ **Channel Metadata**: Added `channel_info_update_date` tracking
- ✅ **Horizon Fields**: `asset_type`, `horizon_start_date`, `horizon_end_date`, `horizon_type`
- ✅ **Verification Metadata**: Detailed verification tracking

### Code Quality
- ✅ **Removed Legacy**: Cleaned up `yahoo-finance2` references
- ✅ **Test Coverage**: Comprehensive testing for all new features
- ✅ **Documentation**: Updated README with all improvements

---

**Built with ❤️ for automated financial analysis**
