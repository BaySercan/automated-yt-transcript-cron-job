import axios from 'axios';
import { config } from './config';
import { logger } from './utils';
import { supabaseService } from './supabase';
import { tickerNormalizationService } from './tickerNormalizationService';

// Lazy load yahooFinance as ESM module
let yahooFinance: any = null;

/**
 * Combined Predictions Service
 * Processes analyzed predictions, fetches historical prices, and stores combined predictions
 * Integrates AI analysis for price predictions and sentiment validation
 */
export class CombinedPredictionsService {
  private readonly DEFAULT_CONCURRENCY = 3;
  private readonly DEFAULT_RETRY_COUNT = 3;
  private readonly INITIAL_BACKOFF_MS = 500;
  private readonly ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || '';
  private readonly FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';
  private readonly TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
  private readonly STOP_ON_RATE_LIMIT = (process.env.STOP_ON_RATE_LIMIT || 'false').toLowerCase() === 'true';
  private disabledProviders: Set<string> = new Set();

  /**
   * Log structured logs similar to edge function
   */
  private log(level: string, message: string, meta: Record<string, any> = {}): void {
    logger[level as keyof typeof logger](message, meta);
  }

  /**
   * Format error messages safely
   */
  private safeErrorMessage(err: any): string {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (typeof err === 'object') return err.message ?? JSON.stringify(err);
    return String(err);
  }

  /**
   * Sleep utility for backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch from AlphaVantage with retries
   */
  private async fetchAlphaVantageWithRetries(
    url: string,
    retryCount: number = this.DEFAULT_RETRY_COUNT,
    requestId: string = ''
  ): Promise<{ ok: boolean; data?: any; error?: string; rateLimited?: boolean }> {
    let attempt = 0;
    let backoff = this.INITIAL_BACKOFF_MS;

    while (attempt <= retryCount) {
      attempt++;
      try {
        const resp = await axios.get(url, { timeout: 10000 });
        const data = resp.data;

        // Check for rate limit indicators
        if (data?.Note || data?.Information || resp.status === 429) {
          this.log('warn', 'AlphaVantage rate limit/info', {
            requestId,
            attempt,
            message: data?.Note ?? data?.Information ?? `HTTP ${resp.status}`
          });
          return { ok: false, error: data?.Note ?? data?.Information ?? `HTTP ${resp.status}`, rateLimited: true };
        }

        return { ok: true, data };
      } catch (err: any) {
        if (err?.isRateLimit) await this.sleep(backoff * 4);
        else await this.sleep(backoff);

        backoff *= 2;

        if (attempt > retryCount) {
          return {
            ok: false,
            error: this.safeErrorMessage(err)
          };
        }
      }
    }

    return {
      ok: false,
      error: 'exhausted retries'
    };
  }

  /**
   * Get historical price for a given date with smart provider fallback
   */
  private async getPriceForDate(
    assetName: string,
    dateStr: string,
    retryCount: number,
    requestId: string
  ): Promise<{ price: number | null; note: string | null; ticker?: string }> {
    try {
      // Normalize asset name to ticker using curated mapping
      const normalized = await tickerNormalizationService.normalizeTicker(assetName, { useAI: false });
      const symbol = normalized.ticker;

      // Primary source: yahoo-finance2 (single, reliable client)
      try {
        if (!this.disabledProviders.has('yahoo2')) {
          const yfRes = await this.getPriceFromYahooFinance(symbol, dateStr);
          if (yfRes.ok) return { price: yfRes.price ?? null, note: null, ticker: symbol };
          if (yfRes.rateLimited) {
            this.log('warn', 'yahoo-finance2 rate limit, disabling provider', { requestId });
            this.disabledProviders.add('yahoo2');
            if (this.STOP_ON_RATE_LIMIT) throw new Error('RateLimitReached');
          }
        }
      } catch (e) {
        this.log('warn', 'yahoo-finance2 fetch failed', { err: this.safeErrorMessage(e), symbol });
      }

      // Try AlphaVantage first
      if (this.ALPHA_VANTAGE_API_KEY && !this.disabledProviders.has('alphavantage')) {
        const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&apikey=${this.ALPHA_VANTAGE_API_KEY}&outputsize=full`;
        const fetchRes = await this.fetchWithFallback('alphavantage', url, 'av', retryCount, requestId);

        if (!fetchRes.ok) {
          if (fetchRes.rateLimited) {
            this.log('warn', 'AlphaVantage rate limit, disabling provider', { requestId });
            this.disabledProviders.add('alphavantage');
            if (this.STOP_ON_RATE_LIMIT) throw new Error('RateLimitReached');
            // otherwise fallthrough to try fallbacks
          } else {
            this.log('warn', 'AlphaVantage fetch failed, trying fallback', { error: fetchRes.error, symbol });
          }
        } else {
          const series = fetchRes.data?.['Time Series (Daily)'];
          if (series && series[dateStr]) {
            const p = parseFloat(series[dateStr]['4. close']);
            if (!isNaN(p)) return { price: p, note: null, ticker: symbol };
          }
        }
      }

      // Fallback 1: Finnhub
      if (this.FINNHUB_API_KEY && !this.disabledProviders.has('finnhub')) {
        try {
          const res = await this.getPriceFromFinnhub(symbol, dateStr);
          if (res.ok) return { price: res.price, note: null, ticker: symbol };
          if (res.rateLimited) {
            this.log('warn', 'Finnhub rate limit, disabling provider', { requestId });
            this.disabledProviders.add('finnhub');
            if (this.STOP_ON_RATE_LIMIT) throw new Error('RateLimitReached');
          }
        } catch (e) {
          this.log('warn', 'Finnhub price fetch failed', { err: this.safeErrorMessage(e), symbol });
        }
      }

      // Fallback 2: TwelveData
      if (this.TWELVE_DATA_API_KEY && !this.disabledProviders.has('twelvedata')) {
        try {
          const res = await this.getPriceFromTwelveData(symbol, dateStr);
          if (res.ok) return { price: res.price, note: null, ticker: symbol };
          if (res.rateLimited) {
            this.log('warn', 'TwelveData rate limit, disabling provider', { requestId });
            this.disabledProviders.add('twelvedata');
            if (this.STOP_ON_RATE_LIMIT) throw new Error('RateLimitReached');
          }
        } catch (e) {
          this.log('warn', 'TwelveData price fetch failed', { err: this.safeErrorMessage(e), symbol });
        }
      }

      // Fallback 3: Yahoo Chart (no API key required)
      if (!this.disabledProviders.has('yahoo')) {
        try {
          const res = await this.getPriceFromYahoo(symbol, dateStr);
          if (res.ok) return { price: res.price, note: null, ticker: symbol };
          if (res.rateLimited) {
            this.log('warn', 'Yahoo rate limit, disabling provider', { requestId });
            this.disabledProviders.add('yahoo');
            if (this.STOP_ON_RATE_LIMIT) throw new Error('RateLimitReached');
          }
        } catch (e) {
          this.log('warn', 'Yahoo price fetch failed', { err: this.safeErrorMessage(e), symbol });
        }
      }

      return { price: null, note: 'no-data-for-date' };
    } catch (err) {
      return {
        price: null,
        note: this.safeErrorMessage(err)
      };
    }
  }

  /**
   * Smart API fallback wrapper with limit detection
   */
  private async fetchWithFallback(provider: string, url: string, shortName: string, retryCount: number, requestId: string): Promise<{ ok: boolean; data?: any; error?: string; rateLimited?: boolean }> {
    try {
      const resp = await axios.get(url, { timeout: 10000 });
      const data = resp.data;

      // Detect rate limit signals
      if (data?.Note || data?.Information || resp.status === 429) {
        const msg = data?.Note ?? data?.Information ?? `HTTP ${resp.status}`;
        this.log('warn', `${shortName} rate limit/info`, { provider, message: msg, requestId });
        return { ok: false, error: msg, rateLimited: true };
      }

      return { ok: true, data };
    } catch (err: any) {
      const msg = this.safeErrorMessage(err);
      // Check if error response indicates rate limiting
      if (err?.response?.status === 429 || msg.toLowerCase().includes('rate') || msg.toLowerCase().includes('limit')) {
        return { ok: false, error: msg, rateLimited: true };
      }
      return { ok: false, error: msg };
    }
  }

  // Minimal Finnhub implementation (requires FINNHUB_API_KEY)
  private async getPriceFromFinnhub(symbol: string, dateStr: string): Promise<{ ok: boolean; price?: number; rateLimited?: boolean }> {
    try {
      const from = Math.floor(new Date(dateStr).getTime() / 1000);
      const to = from + 24 * 60 * 60;
      const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${this.FINNHUB_API_KEY}`;
      const resp = await axios.get(url, { timeout: 10000 });
      const d = resp.data;

      // Check for Finnhub rate limit or errors
      if (d?.error || resp.status === 429) {
        return { ok: false, rateLimited: true };
      }
      if (d && Array.isArray(d.c) && d.c.length > 0) {
        return { ok: true, price: d.c[d.c.length - 1] };
      }
      return { ok: false };
    } catch (err: any) {
      if (err?.response?.status === 429) return { ok: false, rateLimited: true };
      throw err;
    }
  }

  // Minimal TwelveData implementation (requires TWELVE_DATA_API_KEY)
  private async getPriceFromTwelveData(symbol: string, dateStr: string): Promise<{ ok: boolean; price?: number; rateLimited?: boolean }> {
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${dateStr}&end_date=${dateStr}&apikey=${this.TWELVE_DATA_API_KEY}`;
      const resp = await axios.get(url, { timeout: 10000 });
      const d = resp.data;

      // Check for TwelveData rate limit or errors
      if (d?.status === 'error' || resp.status === 429 || d?.message?.toLowerCase().includes('rate')) {
        return { ok: false, rateLimited: true };
      }
      if (d && d.values && d.values.length > 0) {
        const v = d.values[0];
        const p = parseFloat(v.close);
        if (!isNaN(p)) return { ok: true, price: p };
      }
      return { ok: false };
    } catch (err: any) {
      if (err?.response?.status === 429) return { ok: false, rateLimited: true };
      throw err;
    }
  }

  // Yahoo Finance chart endpoint (no API key, best-effort)
  private async getPriceFromYahoo(symbol: string, dateStr: string): Promise<{ ok: boolean; price?: number; rateLimited?: boolean }> {
    try {
      const range = '1d';
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
      const resp = await axios.get(url, { timeout: 10000 });
      const d = resp.data;

      // Check for rate limit
      if (resp.status === 429) return { ok: false, rateLimited: true };

      const close = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.[0];
      if (close || close === 0) return { ok: true, price: close };
      return { ok: false };
    } catch (err: any) {
      if (err?.response?.status === 429) return { ok: false, rateLimited: true };
      throw err;
    }
  }

  // Yahoo Finance via yahoo-finance2 (preferred primary client)
  private async getPriceFromYahooFinance(symbol: string, dateStr: string): Promise<{ ok: boolean; price?: number; rateLimited?: boolean }> {
    try {
      // Lazy load ESM module on first call
      // Lazy load ESM module on first call
      if (!yahooFinance) {
        // Mock Deno to prevent ReferenceError in the package
        if (typeof (global as any).Deno === 'undefined') {
          (global as any).Deno = {
            stdout: {
              write: (data: any) => Promise.resolve(data.length),
              isTerminal: () => false
            },
            stderr: {
              write: (data: any) => Promise.resolve(data.length),
              isTerminal: () => false
            },
            version: { deno: '1.0.0' }
          };
        }

        // Use @gadicc package (v3 JSR) which is modular
        // @ts-ignore: TS2307
        const mod: any = await import('@gadicc/yahoo-finance2');
        // @ts-ignore: TS2307
        const historicalMod: any = await import('@gadicc/yahoo-finance2/modules/historical');
        
        const YahooFinanceClass = mod.default || mod;
        yahooFinance = new YahooFinanceClass({
          modules: { 
            historical: historicalMod.default || historicalMod 
          }
        });
      }

      // Parse target date
      const targetDate = new Date(dateStr);
      if (isNaN(targetDate.getTime())) return { ok: false };

      // Set period2 to the next day to ensure a valid range
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);

      // Call historical with date range
      const res: any = await yahooFinance.historical(symbol, {
        period1: targetDate,
        period2: nextDay
      });

      // res is typically an array of { date, open, high, low, close, adjClose, volume }
      if (Array.isArray(res) && res.length > 0) {
        const item = res[0];
        const close = item?.close ?? item?.adjClose ?? item?.adj_close;
        if (typeof close === 'number' && close > 0) {
          return { ok: true, price: close };
        }
      }

      return { ok: false };
    } catch (err: any) {
      const msg = this.safeErrorMessage(err);
      if (err?.status === 429 || msg.toLowerCase().includes('rate')) return { ok: false, rateLimited: true };
      this.log('warn', 'yahoo-finance2 fetch error', { err: msg, symbol, dateStr });
      return { ok: false };
    }
  }

  /**
   * Format date for API calls
   */
  private formatDateForApi(dateStr: string): string {
    try {
      return new Date(dateStr).toISOString().split('T')[0];
    } catch {
      return dateStr;
    }
  }

  /**
   * Normalize prediction text for deduplication
   */
  private normalizePredictionText(text: any): string {
    if (!text) return '';
    if (typeof text !== 'string') text = JSON.stringify(text);
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /**
   * Create normalized key for duplicate detection
   */
  private createNormalizedKey(videoId: string, asset: string, text: string): string {
    return `${videoId}::${(asset || '').toUpperCase().trim()}::${this.normalizePredictionText(text)}`;
  }

  /**
   * Analyze combined prediction using OpenRouter AI
   * Enriches prediction with AI-generated insights
   */


  /**
   * Insert telemetry record for tracking
   */
  private async insertTelemetry(entry: {
    function: string;
    event: string;
    processed?: number;
    inserted?: number;
    skipped?: number;
    errors?: number;
    prices_fetched?: number;
    runtime_ms?: number;
    request_id?: string;
    details?: Record<string, any>;
  }): Promise<void> {
    try {
      const { error } = await supabaseService.supabase.from('function_logs').insert({
        function: entry.function,
        event: entry.event,
        processed: entry.processed ?? null,
        inserted: entry.inserted ?? null,
        skipped: entry.skipped ?? null,
        errors: entry.errors ?? null,
        prices_fetched: entry.prices_fetched ?? null,
        runtime_ms: entry.runtime_ms ?? null,
        request_id: entry.request_id ?? null,
        details: entry.details ?? {},
        created_at: new Date().toISOString()
      });

      if (error) {
        this.log('warn', 'Telemetry insert failed', {
          err: this.safeErrorMessage(error)
        });
      }
    } catch (err) {
      this.log('warn', 'Telemetry insert unexpected error', {
        err: this.safeErrorMessage(err)
      });
    }
  }

  /**
   * Enrich a batch of predictions using AI to normalize tickers, types, and dates
   */


  /**
   * Main processing function
   * Combines analyzed predictions, fetches prices, and stores in combined_predictions table
   */
  async processPredictions(options: {
    limit?: number;
    skipPrice?: boolean;
    dryRun?: boolean;
    concurrency?: number;
    retryCount?: number;
    enableAIAnalysis?: boolean;
    requestId?: string;
  } = {}): Promise<{
    request_id: string;
    processed_records: number;
    inserted: number;
    skipped: number;
    errors: number;
    prices_fetched: number;
  }> {
    const requestId = options.requestId || crypto.randomUUID?.() || String(Date.now());
    const start = Date.now();

    const limit = Math.max(1, Math.min(2000, options.limit || 500));
    const skipPrice = options.skipPrice ?? false;
    const dryRun = options.dryRun ?? false;
    const concurrency = options.concurrency || this.DEFAULT_CONCURRENCY;
    const retryCount = options.retryCount || this.DEFAULT_RETRY_COUNT;
    const enableAIAnalysis = options.enableAIAnalysis ?? false;

    this.log('info', 'Combined predictions processing started', {
      requestId,
      limit,
      skipPrice,
      dryRun,
      concurrency,
      retryCount,
      enableAIAnalysis
    });

    if (!dryRun) {
      this.insertTelemetry({
        function: 'combine_predictions',
        event: 'started',
        request_id: requestId,
        details: {
          limit,
          skipPrice,
          concurrency,
          retryCount,
          enableAIAnalysis
        }
      }).catch((err) => {
        this.log('warn', 'Failed to insert telemetry', { error: err });
      });
    }

    return this.executeProcessing(requestId, limit, skipPrice, dryRun, concurrency, retryCount, enableAIAnalysis, start);
  }

  /**
   * Resolve horizon date from post_date and horizon_value heuristics
   */
  /**
   * Resolve horizon start and end dates using AI for complex natural language
   */


  /**
   * Reconcile combined_predictions where the horizon date has passed.
   * Updates `status` to 'correct' or 'wrong' based on actual price vs target.
   */
  async reconcilePredictions(options: { limit?: number; dryRun?: boolean; retryCount?: number; useAI?: boolean; requestId?: string } = {}): Promise<void> {
    const requestId = options.requestId || crypto.randomUUID?.() || String(Date.now());
    const limit = options.limit ?? 500;
    const dryRun = options.dryRun ?? false;
    const retryCount = options.retryCount ?? this.DEFAULT_RETRY_COUNT;

    this.log('info', 'Reconciling horizon-passed combined predictions', { requestId, limit, dryRun });

    try {
      const { data: rows, error } = await supabaseService.supabase
        .from('combined_predictions')
        .select('*')
        .eq('status', 'pending')
        .limit(limit);

      if (error) return;

      for (const row of rows || []) {
        try {
          const symbol = row.asset || 'UNKNOWN';
          
          // Fetch latest price
          const todayStr = this.formatDateForApi(new Date().toISOString());
          let actualPrice: number | null = null;
          
          // Use getPriceForDate to fetch current price
          const { price } = await this.getPriceForDate(symbol, todayStr, retryCount, requestId);
          if (price !== null) actualPrice = price;

          let targetPriceNum: number | null = null;
          if (row.target_price) {
            targetPriceNum = parseFloat(String(row.target_price));
            if (isNaN(targetPriceNum)) targetPriceNum = null;
          }

          if (actualPrice === null || targetPriceNum === null) continue;

          let resultStatus: 'correct' | 'wrong' | 'pending' = 'pending';
          const sentiment = (row.sentiment || 'neutral').toString().toLowerCase();
          
          if (sentiment === 'bullish') {
             if (actualPrice >= targetPriceNum) resultStatus = 'correct';
             else resultStatus = 'wrong';
           } else if (sentiment === 'bearish') {
             if (actualPrice <= targetPriceNum) resultStatus = 'correct';
             else resultStatus = 'wrong';
           } else {
             const pct = Math.abs((actualPrice - targetPriceNum) / (targetPriceNum || 1));
             if (pct <= 0.05) resultStatus = 'correct';
             else resultStatus = 'wrong';
           }

          if (!dryRun) {
            await supabaseService.supabase
              .from('combined_predictions')
              .update({ status: resultStatus, actual_price: actualPrice, resolved_at: new Date().toISOString() })
              .eq('id', row.id);
          }
        } catch (e) {
          this.log('error', 'Error reconciling record', { err: this.safeErrorMessage(e), row });
        }
      }
    } catch (err) {
      this.log('error', 'Unhandled error during reconciliation', { err: this.safeErrorMessage(err) });
    }
  }

  /**
   * Check if a target price was hit within a date range
   */
  private async checkPriceTargetInRange(
    symbol: string, 
    startDate: Date, 
    endDate: Date, 
    targetPrice: number, 
    sentiment: string,
    requestId: string
  ): Promise<{ hit: boolean; hitDate: string | null; hitPrice: number | null }> {
    // Optimization: If range is small (e.g., < 5 days), check daily
    // If range is large, we might need a range API (like AlphaVantage TIME_SERIES_DAILY)
    
    // For now, we'll check the end date (legacy behavior) AND the current date if it's within range
    // Ideally, we would fetch the full series. Let's try to fetch the series from AlphaVantage.
    
    try {
      if (this.ALPHA_VANTAGE_API_KEY) {
        const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&apikey=${this.ALPHA_VANTAGE_API_KEY}&outputsize=compact`; // compact = 100 days
        const resp = await axios.get(url);
        const series = resp.data?.['Time Series (Daily)'];
        
        if (series) {
          const startStr = startDate.toISOString().split('T')[0];
          const endStr = endDate.toISOString().split('T')[0];
          
          // Iterate through dates in the series
          for (const [dateStr, data] of Object.entries(series)) {
            if (dateStr >= startStr && dateStr <= endStr) {
              const high = parseFloat((data as any)['2. high']);
              const low = parseFloat((data as any)['3. low']);
              
              if (sentiment === 'bullish' && high >= targetPrice) {
                return { hit: true, hitDate: dateStr, hitPrice: high };
              }
              if (sentiment === 'bearish' && low <= targetPrice) {
                return { hit: true, hitDate: dateStr, hitPrice: low };
              }
            }
          }
        }
      }
    } catch (e) {
      this.log('warn', 'Failed to check price range', { error: e });
    }
    
    return { hit: false, hitDate: null, hitPrice: null };
  }

  /**
   * Execute the actual processing
   */
  private async executeProcessing(
    requestId: string,
    limit: number,
    skipPrice: boolean,
    dryRun: boolean,
    concurrency: number,
    retryCount: number,
    enableAIAnalysis: boolean,
    start: number
  ): Promise<{
    request_id: string;
    processed_records: number;
    inserted: number;
    skipped: number;
    errors: number;
    prices_fetched: number;
  }> {
    let inserted = 0;
    let skipped = 0;
    let errorsCount = 0;
    let pricesFetched = 0;

    try {
      // Fetch unprocessed predictions for combining
      const { data: records, error } = await supabaseService.supabase
        .from('finfluencer_predictions')
        .select('*')
        .eq('subject_outcome', 'analyzed')
        .is('combined_processed_at', null)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw new Error(`Failed to fetch predictions: ${this.safeErrorMessage(error)}`);
      }

      // If no analyzed records found, try pending records with non-empty predictions
      let finalRecords = records || [];
      if (finalRecords.length === 0) {
        this.log('info', 'No unprocessed analyzed records, checking pending records with predictions', { requestId });
        
        const { data: pendingWithPred, error: pendingErr } = await supabaseService.supabase
          .from('finfluencer_predictions')
          .select('*')
          .eq('subject_outcome', 'pending')
          .is('combined_processed_at', null)
          .order('created_at', { ascending: false })
          .limit(limit);

        if (!pendingErr && pendingWithPred) {
          finalRecords = pendingWithPred.filter(rec => {
            try {
              const arr = Array.isArray(rec.predictions) ? rec.predictions : JSON.parse(rec.predictions || '[]');
              return arr.length > 0;
            } catch {
              return false;
            }
          });
        }
      }

      const processedRecords = finalRecords?.length || 0;
      this.log('info', `Processing ${processedRecords} records`, { requestId, recordsFound: processedRecords });

      // Process each record
      for (const rec of finalRecords || []) {
        try {
          const videoId = rec.video_id;
          const predictions = Array.isArray(rec.predictions) ? rec.predictions : JSON.parse(rec.predictions || '[]');
          const postDateObj = rec.post_date ? new Date(rec.post_date) : new Date();
          const postDate = postDateObj.toISOString();
          const postDateFormatted = this.formatDateForApi(postDate);
          
          if (!rec.post_date) {
            this.log('warn', 'Missing post_date for video, defaulting to today', { videoId: rec.video_id });
          }

          if (!Array.isArray(predictions) || predictions.length === 0) {
             // Mark as processed if no predictions
             if (!dryRun) {
                await supabaseService.supabase.from('finfluencer_predictions').update({ combined_processed_at: new Date().toISOString() }).eq('id', rec.id);
             }
             skipped++;
             continue;
          }

          // Fetch existing combined predictions to detect duplicates
          let existingRows: any[] = [];
          try {
            const { data } = await supabaseService.supabase
              .from('combined_predictions')
              .select('video_id, asset, prediction_text')
              .eq('video_id', videoId);
            existingRows = data || [];
          } catch (e) {
             // ignore
          }

          // Process each prediction directly
          for (const p of predictions) {
            try {
              const asset = p.asset || 'UNKNOWN';
              const predictionText = p.prediction_text || '';
              const normalizedKey = this.createNormalizedKey(videoId, asset, predictionText);

              // Check for duplicates
              const isDuplicate = existingRows.some(
                (ex) => this.createNormalizedKey(ex.video_id, ex.asset, ex.prediction_text) === normalizedKey
              );

              if (isDuplicate) {
                skipped++;
                continue;
              }

              // Use raw asset as ticker since we removed AI normalization
              const ticker = asset;
              const currency = '$'; // Default to $
              
              // Fetch historical price if enabled
              let entryPrice = null;
              let formattedEntryPrice = null;
              
              if (!skipPrice && rec.post_date) {
                const { price } = await this.getPriceForDate(ticker, postDateFormatted, retryCount, requestId);
                if (price !== null) {
                  entryPrice = String(price);
                  formattedEntryPrice = `${Math.round(price)}${currency}`;
                  pricesFetched++;
                }
              }

              // Create combined row
              const combinedRow = {
                channel_id: rec.channel_id,
                channel_name: rec.channel_name,
                video_id: videoId,
                post_date: postDate,
                asset,
                asset_entry_price: entryPrice,
                formatted_price: formattedEntryPrice,
                price_currency: currency,
                horizon_value: p.horizon?.value || '',
                sentiment: p.sentiment || 'neutral',
                confidence: p.confidence || 'medium',
                target_price: p.target_price ? String(p.target_price) : null,
                prediction_text: predictionText,
                status: 'pending',
                platform: 'YouTube'
              };

              if (!dryRun) {
                const { error: insertError } = await supabaseService.supabase
                  .from('combined_predictions')
                  .insert(combinedRow);

                if (insertError) {
                  this.log('error', 'Failed to insert combined prediction', { err: this.safeErrorMessage(insertError) });
                  errorsCount++;
                } else {
                  inserted++;
                }
              } else {
                inserted++;
              }

            } catch (predErr) {
              errorsCount++;
            }
          }

          // Mark parent record as processed
          if (!dryRun) {
            await supabaseService.supabase
              .from('finfluencer_predictions')
              .update({ combined_processed_at: new Date().toISOString() })
              .eq('id', rec.id);
          }

        } catch (e) {
          errorsCount++;
          this.log('error', 'Record processing error', { err: this.safeErrorMessage(e) });
        }
      }

      const runtimeMs = Date.now() - start;
      this.log('info', 'Combined predictions processing completed', { requestId, processed_records: processedRecords, inserted, skipped, errors: errorsCount });

      return {
        request_id: requestId,
        processed_records: processedRecords,
        inserted,
        skipped,
        errors: errorsCount,
        prices_fetched: pricesFetched
      };
    } catch (err) {
      throw err;
    }
  }
}

// Export singleton instance
export const combinedPredictionsService = new CombinedPredictionsService();
