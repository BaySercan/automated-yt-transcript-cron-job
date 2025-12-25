# Automated YouTube Transcript Generator v2.0.10

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
8. **Fetches historical asset prices with persistent caching & multi-provider fallback**
9. **Verifies predictions against actual market data with strict horizon enforcement**
10. **Generates comprehensive run reports saved to database**
11. Runs nightly at 23:30 (Europe/Istanbul, UTC+3)

## ✨ Key Features

### Core Functionality

- **🔄 Intelligent Retry Service**: Automatic recovery mechanism for failed predictions
- **📊 Comprehensive Reporting**: Detailed JSON run reports saved to `run_reports` table
- **🖥️ Beautiful CLI**: Color-coded, table-formatted console output for local debugging
- **🤖 AI-Powered Analysis**: Multiple AI model support via OpenRouter
- **🛡️ Robust Error Handling**: Graceful degradation and recovery mechanisms
- **⚡ Performance Optimized**: Memory-efficient processing with adaptive polling
- **🎯 Transcript Validation**: Heuristic validation to ensure real captions/subtitles

### Price Data & Verification

- **💾 Persistent Price Cache**:
  - NEW: `asset_prices` table stores all fetched prices to minimize API costs
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
- **Price APIs**: Yahoo Finance, Twelve Data, Stooq, CoinMarketCap, CoinGecko, Google Finance
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
 ├─ retryService.ts              # Automatic retry service for failed predictions
 ├─ combinedPredictionsService.ts # Combines predictions, fetches prices, verification
 ├─ predictionChecker.ts         # Prediction verification against market data
 ├─ /services
 │  ├─ reportingService.ts       # NEW: Centralized statistics and reporting
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

### Table 4 — `run_reports` (NEW)

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

### Table 5 — `asset_prices` (NEW)

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

## 🔄 Recent Updates (v2.0.3)

### Major Refactoring & Statistics

- ✅ **New Reporting System**: Replaced `CronJobStats` with `ReportingService` and `run_reports` table.
- ✅ **Persistent Price Cache**: Implemented `asset_prices` table to minimize API calls and store history.
- ✅ **Strict Verification**: Now correctly marks predictions as `wrong` if horizon date passes without target validation.
- ✅ **USAGOLD Integration**: Added specific scraper for Gold/Silver prices from USAGOLD.
- ✅ **Code Cleanup**: Removed legacy `function_logs` and unused dependencies.
- ✅ **Batch Processing**: Optimized Yahoo Finance fetching with batch history retrieval.

### Price Fetching & Verification

- ✅ **Stooq Fallback**: Added Stooq.com as fallback price source
- ✅ **Twelve Data Integration**: Dedicated source for Turkish Gram Gold (XAUTRYG)
- ✅ **BIST 100 Support**: Full support for Istanbul Stock Exchange (XU100.IS → ^xutry)
- ✅ **3-Day Window**: Yahoo Finance now uses 3-day window for reliability
- ✅ **Retry Logic**: Stooq automatically retries previous days for missing data

---

**Built with ❤️ for automated financial analysis**
