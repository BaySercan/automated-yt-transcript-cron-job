import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "../utils";
import { config } from "../config";
import { yahooService } from "./yahooService";
import { stooqService } from "./stooqService";
import { supabaseService } from "../supabase";
import { usagoldService } from "./usagoldService";
import { reportingService } from "./reportingService";
import { twelveDataService } from "./twelveDataService";

export class PriceService {
  private readonly USER_AGENT = "Mozilla/5.0";

  // Special mapping for Yahoo Finance symbols
  private readonly SPECIAL_SYMBOLS: { [key: string]: string } = {
    // Indices
    sp500: "^GSPC",
    "s&p500": "^GSPC",
    spx: "^GSPC",
    nasdaq: "^IXIC",
    dow: "^DJI",
    dax: "^GDAXI",
    ftse: "^FTSE",
    nikkei: "^N225",
    bist100: "XU100.IS",
    "bist 100": "XU100.IS",
    xu100: "XU100.IS",

    // Commodities (Futures)
    gold: "GC=F",
    silver: "SI=F",
    crude: "CL=F",
    oil: "CL=F",
    "natural gas": "NG=F",
    xau: "GC=F",
    xag: "SI=F",
    xpt: "PL=F",
    xpd: "PA=F",
    xauusd: "GC=F",
    xagusd: "SI=F",
    spy: "SPY",
    xautryg: "GAUTRYG",
    gautryg: "GAUTRYG",

    // Forex
    eurusd: "EURUSD=X",
    usdjpy: "USDJPY=X",
    gbpusd: "GBPUSD=X",
    usdtry: "USDTRY=X",

    // Bonds / Treasuries
    "us 10y": "^TNX",
    us10y: "^TNX",
    "10 year bond": "^TNX",
    "us 2y": "^TYX",
    us2y: "^TYX",
    "2 year bond": "^TYX",
    "us 5y": "^TYX",
    us5y: "^TYX",
    "5 year bond": "^TYX",
    "us 7y": "^TYX",
    us7y: "^TYX",
    "7 year bond": "^TYX",
    "us 20y": "^TYX",
    us20y: "^TYX",
    "20 year bond": "^TYX",
    "us 30y": "^TYX",
    us30y: "^TYX",
    "30 year bond": "^TYX",

    // Crypto
    btc: "BTC-USD",
    eth: "ETH-USD",
    xrp: "XRP-USD",
    ada: "ADA-USD",
    doge: "DOGE-USD",
    dot: "DOT-USD",
    avax: "AVAX-USD",
    matic: "MATIC-USD",
    link: "LINK-USD",
    uni: "UNI-USD",
    atom: "ATOM-USD",
  };

  /**
   * Detect currency based on symbol and asset type
   * NOTE: Prefer assetClassifierService.classifyAsset() for new code
   * This method is kept for backward compatibility and internal price storage
   */
  detectCurrency(symbol: string, assetType: string = "stock"): string {
    const sym = symbol.toUpperCase();
    const type = assetType.toLowerCase();

    // Crypto is always USD
    if (type === "crypto") {
      return "USD";
    }

    // Forex base currency extraction
    if (type === "forex" || sym.includes("=X")) {
      const cleanSym = sym.replace("=X", "");
      if (cleanSym.length >= 6) {
        // First 3 characters = base currency
        return cleanSym.substring(0, 3);
      }
    }

    // Exchange suffix detection
    if (sym.endsWith(".IS")) return "TRY"; // Turkish
    if (sym.endsWith(".NS") || sym.endsWith(".BO")) return "INR"; // Indian
    if (sym.endsWith(".L")) return "GBP"; // London
    if (sym.endsWith(".T")) return "JPY"; // Tokyo

    // Index-specific detection
    if (type === "index") {
      if (sym === "DAX" || sym === "^GDAXI") return "EUR";
      if (sym === "FTSE" || sym === "^FTSE") return "GBP";
      if (sym === "NIKKEI" || sym === "^N225") return "JPY";
    }

    // Default to USD
    return "USD";
  }

  /**
   * Get display symbol for a currency ISO code
   * @deprecated Use assetClassifierService.classifyAsset() for new code
   */
  getCurrencySymbol(isoCode: string): string {
    const symbols: { [key: string]: string } = {
      USD: "$",
      EUR: "€",
      GBP: "£",
      TRY: "₺",
      JPY: "¥",
      INR: "₹",
      RUB: "₽",
      CNY: "¥",
      KRW: "₩",
      BTC: "₿",
    };
    return symbols[isoCode.toUpperCase()] || isoCode;
  }

  /**
   * Format number in European locale style (1.234,56)
   * Uses . for thousand separator and , for decimal separator
   * @param num Number to format
   * @param decimals Number of decimal places (default 2)
   * @returns Formatted number string
   */
  formatNumberEuropean(num: number, decimals: number = 2): string {
    // Use German locale for proper European formatting
    return num.toLocaleString("de-DE", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: true,
    });
  }

  /**
   * Determine appropriate decimal places based on asset type and price magnitude
   * Crypto: Up to 8 decimals for precision (small values like 0.000045)
   * Forex: 4-5 decimals for currency pairs
   * Commodities: 2 decimals
   * Stocks/Indices: 2 decimals
   * @param assetType The type of asset
   * @param price The price value (used to determine if more decimals are needed)
   * @returns Number of decimal places to display
   */
  private getDynamicDecimalPlaces(assetType: string, price: number): number {
    const type = assetType.toLowerCase();

    if (type === "crypto") {
      // For crypto: if price is very small (< 1), use more decimals for precision
      // Otherwise cap at 8 for extreme cases
      if (price < 0.01) return 8;
      if (price < 0.1) return 6;
      if (price < 1) return 4;
      return 2; // Standard 2 decimals for higher-priced crypto
    }

    if (type === "forex") {
      return 4; // Standard forex precision
    }

    // Commodities, Stocks, Indices
    return 2;
  }

  /**
   * Format price for display with locale-aware formatting and currency symbol
   * Indices show number only (no symbol), other assets show symbol + number
   * Crypto and small-value assets get dynamic decimal places for precision
   * @param price The raw price value
   * @param currencySymbol Display symbol from classification (€, $, ₺, etc.)
   * @param assetType Asset type to determine formatting
   * @returns Formatted price string ready for display
   */
  formatPriceForDisplay(
    price: number,
    currencySymbol: string,
    assetType: string
  ): string {
    if (price === null || price === undefined || isNaN(price)) {
      return "N/A";
    }

    // Determine appropriate decimal places for this asset type
    const decimals = this.getDynamicDecimalPlaces(assetType, price);

    // Format the number in European style (1.234,56 or 0,000045 for crypto)
    const formattedNum = this.formatNumberEuropean(price, decimals);

    // For indices: show number only (no currency symbol)
    if (assetType.toLowerCase() === "index") {
      return formattedNum;
    }

    // For other assets: combine symbol + formatted number
    // If currencySymbol is empty or invalid, fall back to showing just the number
    if (!currencySymbol || currencySymbol.trim().length === 0) {
      return formattedNum;
    }

    return `${currencySymbol}${formattedNum}`;
  }

  /**
   * Normalize asset name to space-less format
   * NOTE: AI classifier now handles most normalization
   * This method provides basic cleanup for database storage consistency
   */
  normalizeAssetName(asset: string): string {
    if (!asset) return "UNKNOWN";

    let normalized = asset.toUpperCase().trim();

    // Remove common separators for consistency
    normalized = normalized
      .replace(/\//g, "") // Remove slashes: USD/TRY -> USDTRY
      .replace(/\s+/g, ""); // Remove spaces: BIST 100 -> BIST100

    // Keep only essential mappings for backward compatibility
    const mappings: { [key: string]: string } = {
      XAU: "GOLD",
      XAUUSD: "GOLD",
      GOLDSPOT: "GOLD",
      XAG: "SILVER",
      XAGUSD: "SILVER",
      SILVERSPOT: "SILVER",
      BITCOIN: "BTC",
      ETHEREUM: "ETH",
    };

    return mappings[normalized] || normalized;
  }

  /**
   * Check if price already exists in combined_predictions table
   * Returns cached price to avoid redundant API calls
   */
  private async getCachedPrice(
    asset: string,
    date: Date
  ): Promise<number | null> {
    try {
      const formattedDate = date.toISOString().split("T")[0];

      const { data, error } = await supabaseService.supabase
        .from("combined_predictions")
        .select("asset_entry_price")
        .ilike("asset", asset)
        .eq("post_date", formattedDate)
        .not("asset_entry_price", "is", null)
        .limit(1)
        .single();

      if (error || !data) {
        return null;
      }

      const price = parseFloat(data.asset_entry_price);
      if (isNaN(price)) {
        return null;
      }

      return price;
    } catch (error) {
      // Silently fail - cache is optional
      return null;
    }
  }

  /**
   * Search for the price of an asset on a specific date
   * Uses cache first, then CoinMarketCap for current crypto, CoinGecko for historical crypto, and Yahoo Finance for others
   */
  // In-memory cache for the current request execution
  private requestCache: Map<string, number> = new Map();

  /**
   * Check asset_prices table for persistent price
   */
  private async checkAssetPriceTable(
    asset: string,
    date: Date
  ): Promise<number | null> {
    try {
      const formattedDate = date.toISOString().split("T")[0];

      const { data, error } = await supabaseService.supabase
        .from("asset_prices")
        .select("price")
        .ilike("asset", asset)
        .eq("date", formattedDate)
        .limit(1)
        .single();

      if (error || !data) {
        return null;
      }
      return Number(data.price);
    } catch (error) {
      return null;
    }
  }

  /**
   * Save found price to asset_prices table
   */
  private async saveToAssetPriceTable(
    asset: string,
    date: Date,
    price: number,
    currency: string = "USD",
    source: string = "unknown"
  ) {
    try {
      const formattedDate = date.toISOString().split("T")[0];
      // Normalize asset name (e.g. BIST 100 -> BIST100)
      const normalizedAsset = this.normalizeAssetName(asset);

      await supabaseService.supabase.from("asset_prices").upsert(
        {
          asset: normalizedAsset,
          date: formattedDate,
          price: price,
          currency: currency,
          source: source,
          created_at: new Date().toISOString(),
        },
        { onConflict: "asset, date" }
      );
    } catch (error) {
      logger.warn(
        `Failed to save price to asset_prices for ${asset}: ${error}`
      );
    }
  }

  /**
   * Batch save prices to asset_prices table
   */
  private async saveBatchToAssetPriceTable(
    asset: string,
    priceMap: Map<string, number>,
    currency: string = "USD",
    source: string = "unknown"
  ) {
    if (priceMap.size === 0) return;

    const rows = [];
    const normalizedAsset = this.normalizeAssetName(asset);

    for (const [dateStr, price] of priceMap.entries()) {
      rows.push({
        asset: normalizedAsset,
        date: dateStr,
        price: price,
        currency: currency,
        source: source,
        created_at: new Date().toISOString(),
      });
    }

    try {
      const { error } = await supabaseService.supabase
        .from("asset_prices")
        .upsert(rows, { onConflict: "asset, date" });

      if (error) throw error;
      logger.info(
        `Batch saved ${rows.length} prices for ${asset} to asset_prices`
      );
    } catch (error) {
      logger.warn(`Failed to batch save prices for ${asset}: ${error}`);
    }
  }

  /**
   * Get exchange rate between two currencies for a specific date
   * First checks asset_prices table, then queries Yahoo Finance API if not found
   * Stores new rates in asset_prices table for future use
   * @param fromCurrency Source currency (e.g., "USD")
   * @param toCurrency Target currency (e.g., "TRY")
   * @param date Date to get rate for
   * @returns Object with rate, source ("cache" or "api"), and date_found
   */
  async getExchangeRateForDate(
    fromCurrency: string,
    toCurrency: string,
    date: Date
  ): Promise<{
    rate: number | null;
    source: "cache" | "api";
    date_found: string;
  }> {
    try {
      if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
        // No conversion needed if same currency
        return {
          rate: 1,
          source: "cache",
          date_found: date.toISOString().split("T")[0],
        };
      }

      const fromUpper = fromCurrency.toUpperCase();
      const toUpper = toCurrency.toUpperCase();
      const formattedDate = date.toISOString().split("T")[0];
      const pairSymbol = `${fromUpper}${toUpper}`;

      logger.info(
        `Getting exchange rate for ${fromUpper}/${toUpper} on ${formattedDate}...`
      );

      // Step 1: Check asset_prices table first (cached rates)
      try {
        const { data, error } = await supabaseService.supabase
          .from("asset_prices")
          .select("price, date")
          .eq("asset", pairSymbol)
          .eq("date", formattedDate)
          .limit(1)
          .single();

        if (!error && data) {
          logger.info(
            `Found cached exchange rate for ${pairSymbol} on ${formattedDate}: ${data.price}`
          );
          return {
            rate: Number(data.price),
            source: "cache",
            date_found: data.date,
          };
        }
      } catch (tableErr) {
        logger.debug(`asset_prices table lookup failed: ${tableErr}`);
      }

      // Step 2: Try Yahoo Finance API for historical rate
      // Use special symbols mapping for forex pairs
      const yahooSymbol =
        this.SPECIAL_SYMBOLS[pairSymbol.toLowerCase()] ||
        `${fromUpper}${toUpper}=X`;

      logger.info(
        `Querying Yahoo Finance API for ${yahooSymbol} on ${formattedDate}...`
      );

      try {
        const rate = await yahooService.getHistory(yahooSymbol, date);

        if (rate !== null) {
          logger.info(
            `Got exchange rate from Yahoo Finance for ${pairSymbol} on ${formattedDate}: ${rate}`
          );

          // Store in asset_prices table for future use
          this.saveToAssetPriceTable(
            pairSymbol,
            date,
            rate,
            "rate",
            "yahoo_finance"
          );

          return { rate, source: "api", date_found: formattedDate };
        }
      } catch (apiErr) {
        logger.warn(
          `Yahoo Finance API lookup failed for ${yahooSymbol}: ${apiErr}`
        );
      }

      // Step 3: If date is recent, try fetching today's rate and using it as approximation
      const today = new Date().toISOString().split("T")[0];
      if (formattedDate !== today) {
        try {
          logger.info(
            `${formattedDate} rate not found, trying to get current ${pairSymbol} rate...`
          );
          const currentDate = new Date();
          const currentRate = await yahooService.getHistory(
            yahooSymbol,
            currentDate
          );

          if (currentRate !== null) {
            logger.info(
              `Using current exchange rate as fallback for ${pairSymbol}: ${currentRate}`
            );
            return { rate: currentRate, source: "api", date_found: today };
          }
        } catch (fallbackErr) {
          logger.warn(`Current rate fallback also failed: ${fallbackErr}`);
        }
      }

      // No rate found
      logger.warn(
        `Could not find exchange rate for ${fromUpper}/${toUpper} on ${formattedDate}`
      );
      return { rate: null, source: "api", date_found: formattedDate };
    } catch (error) {
      logger.error(`Error getting exchange rate: ${error}`);
      return {
        rate: null,
        source: "api",
        date_found: date.toISOString().split("T")[0],
      };
    }
  }

  /**
   * Convert a price from one currency to another using historical rates
   * @param price Price to convert
   * @param fromCurrency Source currency (e.g., "USD")
   * @param toCurrency Target currency (e.g., "TRY")
   * @param date Date for exchange rate lookup
   * @returns Converted price or null if conversion fails
   */
  async convertPriceToCurrency(
    price: number,
    fromCurrency: string,
    toCurrency: string,
    date: Date
  ): Promise<number | null> {
    if (fromCurrency === toCurrency) {
      return price; // No conversion needed
    }

    const { rate, source, date_found } = await this.getExchangeRateForDate(
      fromCurrency,
      toCurrency,
      date
    );

    if (rate === null) {
      logger.warn(
        `Conversion failed: no rate found for ${fromCurrency}/${toCurrency}`
      );
      return null;
    }

    const convertedPrice = price * rate;
    logger.info(
      `Converted ${price} ${fromCurrency} to ${convertedPrice} ${toCurrency} using rate ${rate} from ${source} (${date_found})`
    );

    return convertedPrice;
  }

  /**
   * Search for the price of an asset on a specific date
   * Uses cache first, then CoinMarketCap for current crypto, CoinGecko for historical crypto, and Yahoo Finance for others
   */
  async searchPrice(
    asset: string,
    date: Date,
    assetType?: string
  ): Promise<number | null> {
    try {
      reportingService.incrementPriceRequest();
      const formattedDate = date.toISOString().split("T")[0];
      const cacheKey = `${asset.toUpperCase()}:${formattedDate}`;

      // 0a. Check request-scoped memory cache
      if (this.requestCache.has(cacheKey)) {
        const cached = this.requestCache.get(cacheKey);
        if (cached !== undefined) {
          logger.info(
            `Using memory cached price for ${asset} on ${formattedDate}: ${cached}`
          );
          reportingService.incrementPriceCacheHit();
          reportingService.incrementPriceSuccess();
          return cached;
        }
      }

      // 0b. Check dedicated asset_prices table (Primary Persistent Cache)
      const persistentPrice = await this.checkAssetPriceTable(asset, date);
      if (persistentPrice !== null) {
        logger.info(
          `Using persistent price from asset_prices for ${asset} on ${formattedDate}: ${persistentPrice}`
        );
        this.requestCache.set(cacheKey, persistentPrice);
        reportingService.incrementPriceCacheHit();
        reportingService.incrementPriceSuccess();
        return persistentPrice;
      }

      // 0c. Check combined_predictions table (Legacy Cache)
      const cachedPrice = await this.getCachedPrice(asset, date);
      if (cachedPrice !== null) {
        logger.info(
          `Using legacy cached price for ${asset} on ${formattedDate}: ${cachedPrice}`
        );
        this.requestCache.set(cacheKey, cachedPrice);

        // Backfill to new table for future speed
        this.saveToAssetPriceTable(
          asset,
          date,
          cachedPrice,
          this.detectCurrency(asset),
          "legacy_backfill"
        );
        reportingService.incrementPriceCacheHit();
        reportingService.incrementPriceSuccess();
        return cachedPrice;
      }

      const today = new Date().toISOString().split("T")[0];
      const isToday = formattedDate === today;

      // Check if it's a crypto asset
      const assetUpper = asset.toUpperCase().trim();
      const isCrypto =
        assetType?.toLowerCase() === "crypto" ||
        [
          "BTC",
          "ETH",
          "SOL",
          "XRP",
          "ADA",
          "DOGE",
          "DOT",
          "AVAX",
          "MATIC",
          "LINK",
          "UNI",
          "ATOM",
        ].includes(assetUpper);

      // 1. For CURRENT crypto prices, use CoinMarketCap API (fast & reliable)
      if (isCrypto && isToday) {
        logger.info(
          `Fetching current crypto price for ${asset} via CoinMarketCap API...`
        );
        const cmcPrice = await this.fetchCryptoPrice(asset, date);
        if (cmcPrice !== null) {
          reportingService.incrementPriceApiCall("coinmarketcap");
          reportingService.incrementPriceSuccess();
          this.saveToAssetPriceTable(
            asset,
            date,
            cmcPrice,
            "USD",
            "coinmarketcap"
          );
          return cmcPrice;
        }
      }

      // 2. Historical crypto prices via CoinGecko
      if (isCrypto && !isToday) {
        logger.info(
          `Fetching historical crypto price for ${asset} via CoinGecko API...`
        );
        const coinGeckoPrice = await this.fetchCoinGeckoHistory(asset, date);
        if (coinGeckoPrice !== null) {
          reportingService.incrementPriceApiCall("coingecko");
          reportingService.incrementPriceSuccess();
          this.saveToAssetPriceTable(
            asset,
            date,
            coinGeckoPrice,
            "USD",
            "coingecko"
          );
          return coinGeckoPrice;
        }
      }

      // 3. Gold/Silver LIVE prices via USAGOLD (current only, historical needs browser)
      // Supports GOLD, XAU, XAUUSD (USD/Ounce) and XAUTRYG (TRY/Gram - local Turkish market)
      if (isToday) {
        // XAUUSD = Ounce Gold / USD (international commodity market, ~31.1 grams per ounce)
        if (
          assetUpper === "GOLD" ||
          assetUpper === "XAU" ||
          assetUpper === "XAUUSD" ||
          assetUpper === "GC=F"
        ) {
          logger.info(`Fetching live gold price (USD/Ounce) from USAGOLD...`);
          const goldPrice = await usagoldService.getLiveGoldPrice();
          if (goldPrice !== null) {
            reportingService.incrementPriceApiCall("usagold");
            reportingService.incrementPriceSuccess();
            this.saveToAssetPriceTable(
              asset,
              date,
              goldPrice,
              "USD",
              "usagold"
            );
            return goldPrice;
          }
        }

        // XAUTRYG = Gram Gold / Turkish Lira (local Turkish precious metals market)
        // Note: This is a local Turkish market price, not directly available via USAGOLD
        // Would need to call a Turkish precious metals provider or forex conversion
        // For now, this will fallback to Yahoo Finance which may have XAUTRY or similar
        if (assetUpper === "XAUTRYG") {
          logger.info(
            `Fetching gram gold price (TRY) for Turkish market (XAUTRYG) via Twelve Data...`
          );
          const tdPrice = await twelveDataService.getLivePrice();
          if (tdPrice !== null) {
            reportingService.incrementPriceApiCall("twelvedata");
            reportingService.incrementPriceSuccess();
            this.saveToAssetPriceTable(
              asset,
              date,
              tdPrice,
              "TRY",
              "twelvedata"
            );
            return tdPrice;
          }
          logger.warn(
            "Twelve Data live fetch failed for XAUTRYG, falling back to generic providers..."
          );
        }

        if (
          assetUpper === "SILVER" ||
          assetUpper === "XAG" ||
          assetUpper === "SI=F"
        ) {
          logger.info(`Fetching live silver price from USAGOLD...`);
          const silverPrice = await usagoldService.getLiveSilverPrice();
          if (silverPrice !== null) {
            reportingService.incrementPriceApiCall("usagold");
            reportingService.incrementPriceSuccess();
            this.saveToAssetPriceTable(
              asset,
              date,
              silverPrice,
              "USD",
              "usagold"
            );
            return silverPrice;
          }
        }
      }

      // 3.5. XAUTRYG Historical via Twelve Data
      if (assetUpper === "XAUTRYG" && !isToday) {
        logger.info(`Fetching historical XAUTRYG price from Twelve Data...`);
        const tdHistPrice = await twelveDataService.getHistoricalPrice(date);
        if (tdHistPrice !== null) {
          reportingService.incrementPriceApiCall("twelvedata");
          reportingService.incrementPriceSuccess();
          this.saveToAssetPriceTable(
            asset,
            date,
            tdHistPrice,
            "TRY",
            "twelvedata"
          );
          return tdHistPrice;
        }
      }

      // 4. Try Yahoo Finance with special symbol mapping (Main provider for stocks/forex)
      logger.info(
        `Searching price for ${asset} on ${formattedDate} via Yahoo Finance...`
      );
      try {
        // First try to resolve the symbol using our helper
        let yahooSymbol = await this.resolveYahooTicker(asset);

        // If helper fails or returns generic, try the Yahoo Search API via yahooService
        if (!yahooSymbol || yahooSymbol === asset) {
          const searched = await yahooService.search(asset);
          if (searched) yahooSymbol = searched;
        }

        logger.info(`Resolved Yahoo symbol for ${asset}: ${yahooSymbol}`);

        // BATCH FETCH OPTIMIZATION
        // Instead of fetching just 1 day, fetch the last 30 days to populate cache
        // Start date: 30 days ago. End date: Requested date + 2 days (for weekend coverage)
        const startDate = new Date(date);
        startDate.setDate(startDate.getDate() - 30);

        const endDate = new Date(date);
        endDate.setDate(endDate.getDate() + 2);

        // Use the new batch fetching method
        const priceMap = await yahooService.getHistoryRange(
          yahooSymbol,
          startDate,
          endDate
        );

        if (priceMap.size > 0) {
          // Save ALL fetched prices to DB
          const currency = this.detectCurrency(yahooSymbol);
          await this.saveBatchToAssetPriceTable(
            asset,
            priceMap,
            currency,
            "yahoo"
          );

          // Return specific requested date if found
          if (priceMap.has(formattedDate)) {
            const foundPrice = priceMap.get(formattedDate)!;
            logger.info(
              `Found price for ${asset} (${yahooSymbol}) on ${formattedDate}: ${foundPrice} (Batch Hit)`
            );
            reportingService.incrementPriceApiCall("yahoo");
            reportingService.incrementPriceSuccess();
            return foundPrice;
          } else {
            // If specific date not found (e.g. weekend), try find nearest?
            // Currently returning null serves as retry signal or fallback,
            // but usually Yahoo returns 'null' for weekends.
            // We could check surrounding days here if we wanted robust logic,
            // but let's stick to returning exact match first.
            // Actually, if we fetched 30 days and didn't find it, it likely doesn't exist for that date.
            logger.warn(
              `Batch fetch successful but ${formattedDate} specific price missing for ${asset}`
            );
          }
        } else {
          // Fallback to single fetch if batch returns empty (rare, but maybe different API behavior)
          // or just treat as not found.
          logger.warn(`Yahoo batch fetch returned 0 results for ${asset}`);
        }
      } catch (yahooError: any) {
        logger.warn(
          `Yahoo Finance fetch failed for ${asset}: ${yahooError.message}`
        );
      }

      // 5. Fallback: Stooq (for historical prices when Yahoo fails)
      if (!isToday && !isCrypto) {
        logger.info(
          `Falling back to Stooq for ${asset} on ${formattedDate}...`
        );
        try {
          let yahooSymbol = await this.resolveYahooTicker(asset);
          if (!yahooSymbol || yahooSymbol === asset) {
            yahooSymbol = asset;
          }

          const stooqResult = await stooqService.getHistoricalPrice(
            yahooSymbol,
            date
          );
          if (stooqResult.close !== null) {
            logger.info(
              `Found price for ${asset} on ${formattedDate} via Stooq: ${stooqResult.close}`
            );
            reportingService.incrementPriceApiCall("stooq");
            reportingService.incrementPriceSuccess();
            this.saveToAssetPriceTable(
              asset,
              date,
              stooqResult.close,
              this.detectCurrency(yahooSymbol),
              "stooq"
            );
            this.requestCache.set(cacheKey, stooqResult.close);
            return stooqResult.close;
          }
        } catch (stooqError: any) {
          logger.warn(`Stooq fetch failed for ${asset}: ${stooqError.message}`);
        }
      }

      reportingService.incrementPriceFailed();
      return null;
    } catch (error: any) {
      logger.error("Error searching price", { error: error.message, asset });
      reportingService.incrementPriceFailed();
      return null;
    }
  }

  /**
   * Search for price with fallback to previous dates (for holidays/weekends)
   * Tries exact date first, then falls back to previous dates up to maxLookbackDays
   * Useful for entry price fetching when market was closed on the original date
   */
  async searchPriceWithFallback(
    asset: string,
    date: Date,
    assetType?: string,
    maxLookbackDays: number = 5
  ): Promise<number | null> {
    // Try exact date first
    const exactPrice = await this.searchPrice(asset, date, assetType);
    if (exactPrice !== null) {
      logger.info(
        `Found price for ${asset} on exact date ${
          date.toISOString().split("T")[0]
        }: ${exactPrice}`
      );
      return exactPrice;
    }

    // If exact date failed, try previous dates
    logger.info(
      `Exact date price not found for ${asset}, trying fallback dates (max ${maxLookbackDays} days back)...`
    );

    for (let i = 1; i <= maxLookbackDays; i++) {
      const fallbackDate = new Date(date);
      fallbackDate.setDate(fallbackDate.getDate() - i);

      const fallbackPrice = await this.searchPrice(
        asset,
        fallbackDate,
        assetType
      );
      if (fallbackPrice !== null) {
        logger.info(
          `Found price for ${asset} on fallback date ${
            fallbackDate.toISOString().split("T")[0]
          } (${i} day(s) back): ${fallbackPrice}`
        );
        return fallbackPrice;
      }
    }

    logger.warn(
      `No price found for ${asset} within ${maxLookbackDays} days lookback`
    );
    return null;
  }

  // Helper method to set cache from other internal methods if needed
  private setCache(asset: string, date: Date, price: number) {
    const formattedDate = date.toISOString().split("T")[0];
    const cacheKey = `${asset.toUpperCase()}:${formattedDate}`;
    this.requestCache.set(cacheKey, price);
  }

  /**
   * Resolve asset name to Yahoo Finance ticker
   */
  private async resolveYahooTicker(query: string): Promise<string> {
    const key = query.toLowerCase().replace(/\s+/g, "");

    // Check special mapping
    if (this.SPECIAL_SYMBOLS[key]) {
      return this.SPECIAL_SYMBOLS[key];
    }

    return query;
  }

  /**
   * Original Google Finance logic, moved to helper method
   */
  private async searchGoogleFinancePrice(
    asset: string,
    assetType?: string
  ): Promise<number | null> {
    const searchAsset = this.constructQuery(asset, assetType);

    const initialUrl = `https://www.google.com/finance/quote/${encodeURIComponent(
      searchAsset
    )}`;
    let html = await this.fetchHtml(initialUrl);

    if (!html) return null;

    let price = this.parsePriceFromGoogleFinance(html);

    if (price === null) {
      const quoteLink = this.findFirstQuoteLink(html, searchAsset);
      if (quoteLink) {
        const cleanLink = quoteLink.replace(/^\.\/quote\//, "");
        const followUrl = `https://www.google.com/finance/quote/${cleanLink}`;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * 1000 + 500)
        );
        html = await this.fetchHtml(followUrl);
        if (html) {
          price = this.parsePriceFromGoogleFinance(html);
        }
      }
    }
    return price;
  }

  /**
   * Fetch historical cryptocurrency price from CoinGecko API
   * Endpoint: /coins/{id}/history
   */
  private async fetchCoinGeckoHistory(
    symbol: string,
    date: Date
  ): Promise<number | null> {
    try {
      if (!config.coingeckoApiKey) {
        logger.warn(
          "COINGECKO_API_KEY not configured, cannot fetch historical crypto prices"
        );
        return null;
      }

      const coinId = this.getCoinGeckoId(symbol);
      if (!coinId) {
        logger.warn(`No CoinGecko ID mapping found for symbol: ${symbol}`);
        return null;
      }

      // Format date as dd-mm-yyyy
      const day = date.getDate().toString().padStart(2, "0");
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      const year = date.getFullYear();
      const dateStr = `${day}-${month}-${year}`;

      logger.info(
        `Fetching historical price for ${coinId} on ${dateStr} from CoinGecko...`
      );

      const response = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${coinId}/history`,
        {
          params: {
            date: dateStr,
            localization: false,
          },
          headers: {
            "x-cg-demo-api-key": config.coingeckoApiKey,
            Accept: "application/json",
          },
          timeout: 15000,
        }
      );

      if (
        response.data &&
        response.data.market_data &&
        response.data.market_data.current_price
      ) {
        const price = response.data.market_data.current_price.usd;
        if (price !== null && price !== undefined) {
          logger.info(
            `Found historical price for ${symbol} (${dateStr}): $${price}`
          );
          return price;
        }
      }

      logger.warn(`No historical price data found for ${symbol} on ${dateStr}`);
      return null;
    } catch (error: any) {
      if (error.response) {
        logger.error(`CoinGecko API error for ${symbol}:`, {
          status: error.response.status,
          message: error.response.data?.error || error.message,
        });
      } else {
        logger.error(
          `Error fetching historical price for ${symbol}:`,
          error.message
        );
      }
      return null;
    }
  }

  /**
   * Map common symbols to CoinGecko IDs
   */
  private getCoinGeckoId(symbol: string): string | null {
    const map: { [key: string]: string } = {
      BTC: "bitcoin",
      ETH: "ethereum",
      SOL: "solana",
      XRP: "ripple",
      ADA: "cardano",
      DOGE: "dogecoin",
      DOT: "polkadot",
      AVAX: "avalanche-2",
      MATIC: "matic-network",
      LINK: "chainlink",
      UNI: "uniswap",
      ATOM: "cosmos",
      LTC: "litecoin",
      BCH: "bitcoin-cash",
      ALGO: "algorand",
      XLM: "stellar",
      NEAR: "near",
      QNT: "quant-network",
      FIL: "filecoin",
      HBAR: "hedera-hashgraph",
    };
    return map[symbol.toUpperCase().trim()] || null;
  }

  /**
   * Fetch cryptocurrency price from CoinMarketCap API
   * Uses current price endpoint - perfect for horizon date checks and same-day processing
   */
  private async fetchCryptoPrice(
    symbol: string,
    date: Date
  ): Promise<number | null> {
    try {
      if (!config.cmcProApiKey) {
        logger.warn(
          "CMC_PRO_API_KEY not configured, cannot fetch crypto prices"
        );
        return null;
      }

      const symbolUpper = symbol.toUpperCase().trim();

      logger.info(
        `Fetching current crypto price for ${symbolUpper} from CoinMarketCap...`
      );

      const response = await axios.get(
        "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest",
        {
          params: {
            symbol: symbolUpper,
            convert: "USD",
          },
          headers: {
            "X-CMC_PRO_API_KEY": config.cmcProApiKey,
            Accept: "application/json",
          },
          timeout: 15000,
        }
      );

      if (
        response.data &&
        response.data.data &&
        response.data.data[symbolUpper]
      ) {
        const cryptoData = response.data.data[symbolUpper];

        if (
          cryptoData.quote &&
          cryptoData.quote.USD &&
          cryptoData.quote.USD.price
        ) {
          const price = cryptoData.quote.USD.price;

          if (price !== null && price !== undefined) {
            logger.info(
              `Found crypto price for ${symbolUpper}: $${price.toFixed(2)}`
            );
            return price;
          }
        }
      }

      logger.warn(`No price data found for ${symbolUpper}`);
      return null;
    } catch (error: any) {
      if (error.response) {
        logger.error(`CoinMarketCap API error for ${symbol}:`, {
          status: error.response.status,
          message: error.response.data?.status?.error_message || error.message,
        });
      } else {
        logger.error(
          `Error fetching crypto price for ${symbol}:`,
          error.message
        );
      }
      return null;
    }
  }

  /**
   * Construct a search query based on asset type and name for Google Finance
   */
  private constructQuery(asset: string, assetType?: string): string {
    let searchAsset = asset.toUpperCase().trim();

    // Handle Crypto logic: Default to USD pair if not specified
    // Google Finance uses "BTC-USD", "ETH-USD" format
    const isCrypto =
      assetType?.toLowerCase() === "crypto" ||
      ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "DOT", "AVAX"].includes(
        searchAsset
      );

    if (
      isCrypto &&
      !searchAsset.includes("-") &&
      !searchAsset.includes("USD")
    ) {
      searchAsset = `${searchAsset}-USD`;
    }

    return searchAsset;
  }

  private async fetchHtml(url: string): Promise<string | null> {
    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent": this.USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "max-age=0",
        },
        timeout: 15000,
        validateStatus: (status) => status === 200, // Only accept 200
      });
      return response.data;
    } catch (error: any) {
      logger.warn(`Failed to fetch ${url}: ${error.message}`);
      return null;
    }
  }

  private parsePriceFromGoogleFinance(html: string): number | null {
    const $ = cheerio.load(html);

    // Selectors for price on Google Finance quote page
    // .AHmHk .fxKbKc is often the main price
    // .YMlKec.fxKbKc is another common one
    const selectors = [".AHmHk .fxKbKc", ".YMlKec.fxKbKc", "[data-last-price]"];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length > 0) {
        const text = element.text().trim();
        // Remove currency symbols and commas
        const cleanText = text.replace(/[^\d.-]/g, "");
        const price = parseFloat(cleanText);
        if (!isNaN(price)) {
          return price;
        }
      }
    }
    return null;
  }

  private findFirstQuoteLink(html: string, searchAsset: string): string | null {
    const $ = cheerio.load(html);
    let foundLink: string | null = null;

    // Normalize search asset for comparison
    const normalizedAsset = searchAsset
      .replace(/[^a-zA-Z0-9]/g, "")
      .toUpperCase();

    $("a").each((_, el) => {
      if (foundLink) return; // Stop after first find
      const href = $(el).attr("href");
      // Look for links that look like quote links
      // In debug output: "./quote/AAPL:NASDAQ"
      if (href && href.includes("quote/") && href.includes(":")) {
        // Prioritize links that contain the asset name/ticker
        const normalizedHref = href.toUpperCase();
        if (normalizedHref.includes(normalizedAsset)) {
          foundLink = href;
        }
      }
    });

    // If no specific match found, fallback to the first quote link (risky but better than nothing)
    if (!foundLink) {
      $("a").each((_, el) => {
        if (foundLink) return;
        const href = $(el).attr("href");
        if (href && href.includes("quote/") && href.includes(":")) {
          foundLink = href;
        }
      });
    }

    return foundLink;
  }

  /**
   * Calculate horizon date range based on post date and horizon value
   * Returns a start and end date for the verification window
   */
  calculateHorizonDateRange(
    postDate: Date,
    horizonValue: string,
    horizonType: string = "custom"
  ): { start: Date; end: Date } {
    const start = new Date(postDate);
    const end = new Date(postDate);
    const value = horizonValue.toLowerCase().trim();
    const type = horizonType.toLowerCase();

    // 1. Exact Date
    if (type === "exact") {
      // Try to parse the date from value
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        return { start: parsed, end: parsed };
      }
    }

    // 2. End of Year
    if (
      type === "end_of_year" ||
      value.includes("end of year") ||
      value.includes("eoy") ||
      value.includes("yil sonu")
    ) {
      // Start checking from Dec 1st of that year
      end.setMonth(11, 31); // Dec 31st
      start.setFullYear(end.getFullYear(), 11, 1); // Dec 1st
      return { start, end };
    }

    // 3. Quarter
    if (
      type === "quarter" ||
      value.includes("quarter") ||
      value.includes(" çeyrek")
    ) {
      // Check for Q1, Q2, Q3, Q4
      const qMatch = value.match(/q([1-4])/i);
      if (qMatch) {
        const q = parseInt(qMatch[1], 10);
        const yearMatch = value.match(/20\d{2}/);
        const year = yearMatch
          ? parseInt(yearMatch[0], 10)
          : start.getFullYear();

        // Q1: Jan-Mar (0-2), Q2: Apr-Jun (3-5), Q3: Jul-Sep (6-8), Q4: Oct-Dec (9-11)
        const startMonth = (q - 1) * 3;
        start.setFullYear(year, startMonth, 1);
        end.setFullYear(year, startMonth + 2 + 1, 0); // Last day of the quarter
        return { start, end };
      }

      // Default relative quarter (3 months from post date)
      end.setMonth(end.getMonth() + 3);
      start.setTime(postDate.getTime()); // FIX: Start from postDate, not +2 months
      return { start, end };
    }

    // 4. Month
    if (type === "month" || value.includes("month") || value.includes(" ay")) {
      // Check for named months
      const months = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ];
      const monthsTr = [
        "ocak",
        "subat",
        "mart",
        "nisan",
        "mayis",
        "haziran",
        "temmuz",
        "agustos",
        "eylul",
        "ekim",
        "kasim",
        "aralik",
      ];

      let targetMonth = -1;
      for (let i = 0; i < 12; i++) {
        if (
          value.toLowerCase().includes(months[i]) ||
          value.toLowerCase().includes(monthsTr[i])
        ) {
          targetMonth = i;
          break;
        }
      }

      if (targetMonth !== -1) {
        const yearMatch = value.match(/20\d{2}/);
        let year = yearMatch ? parseInt(yearMatch[0], 10) : start.getFullYear();

        // If target month is in the past relative to now, assume next year
        // But here we are calculating relative to postDate.
        if (targetMonth < start.getMonth() && !yearMatch) {
          year++;
        }

        start.setFullYear(year, targetMonth, 1);
        end.setFullYear(year, targetMonth + 1, 0); // Last day of month
        return { start, end };
      }

      // Relative month number
      const numberMatch = value.match(/(\d+)/);
      const number = numberMatch ? parseInt(numberMatch[1], 10) : 1;

      end.setMonth(end.getMonth() + number);
      start.setTime(postDate.getTime()); // FIX: Use postDate, not end, to preserve verification window
      return { start, end };
    }

    // 5. Default / Relative logic (weeks, days, years)
    const numberMatch = value.match(/(\d+)/);
    const number = numberMatch ? parseInt(numberMatch[1], 10) : 1;

    if (value.includes("year") || value.includes("yil")) {
      end.setFullYear(end.getFullYear() + number);
    } else if (value.includes("week") || value.includes("hafta")) {
      end.setDate(end.getDate() + number * 7);
    } else if (value.includes("day") || value.includes("gun")) {
      end.setDate(end.getDate() + number);
    } else {
      // Default fallback: 1 month
      end.setMonth(end.getMonth() + 1);
    }

    // For relative dates/custom text, the window should be from postDate until the end date
    // This allows verifying if the target was hit ANYTIME during that period
    start.setTime(postDate.getTime());

    return { start, end };
  }

  /**
   * Verify prediction accuracy across a date range
   * Checks if the target was met on ANY day within the range
   */
  async verifyPredictionWithRange(
    asset: string,
    entryPrice: number | null,
    targetPrice: number | null,
    sentiment: string,
    horizonStart: Date,
    horizonEnd: Date,
    assetType?: string
  ): Promise<{
    status: "correct" | "wrong" | "pending";
    metDate?: Date;
    actualPrice?: number;
  }> {
    const now = new Date();

    // If range hasn't started yet, it's pending
    if (now < horizonStart) {
      return { status: "pending" };
    }

    // Cap the end date to today (cannot check future prices)
    const checkEnd = horizonEnd > now ? now : horizonEnd;
    const checkStart = horizonStart;

    // Iterate through days in range (daily resolution)
    // Optimization: If range is huge, maybe check weekly? But daily is safer for targets.
    // Limit: Don't check more than 365 days to avoid API abuse
    const MAX_DAYS = 60;
    const oneDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.round(
      Math.abs((checkEnd.getTime() - checkStart.getTime()) / oneDay)
    );

    if (diffDays > MAX_DAYS) {
      logger.warn(
        `Verification range too large (${diffDays} days) for ${asset}. Checking only start and end.`
      );
      // Fallback: Check start and end only
      const startPrice = await this.searchPrice(asset, checkStart, assetType);
      if (
        startPrice &&
        this.checkHit(entryPrice, startPrice, targetPrice, sentiment, assetType)
      ) {
        return {
          status: "correct",
          metDate: checkStart,
          actualPrice: startPrice,
        };
      }
      const endPrice = await this.searchPrice(asset, checkEnd, assetType);
      if (
        endPrice &&
        this.checkHit(entryPrice, endPrice, targetPrice, sentiment, assetType)
      ) {
        return { status: "correct", metDate: checkEnd, actualPrice: endPrice };
      }
    } else {
      // Daily check
      for (
        let d = new Date(checkStart);
        d <= checkEnd;
        d.setDate(d.getDate() + 1)
      ) {
        const price = await this.searchPrice(asset, d, assetType);
        if (price !== null) {
          if (
            this.checkHit(entryPrice, price, targetPrice, sentiment, assetType)
          ) {
            return {
              status: "correct",
              metDate: new Date(d),
              actualPrice: price,
            };
          }
        }
      }
    }

    // If we reached here:
    // 1. If horizonEnd has passed, and we never hit target -> WRONG
    // 2. If horizonEnd is in future, and we haven't hit target yet -> PENDING

    if (now > horizonEnd) {
      // Final check on the last day price to determine "wrong" value
      const finalPrice = await this.searchPrice(asset, checkEnd, assetType);
      // Only return actualPrice if it's a valid non-zero value
      // Returning undefined instead of 0 prevents storing meaningless "0.0000000" in DB
      return {
        status: "wrong",
        actualPrice: finalPrice && finalPrice > 0 ? finalPrice : undefined,
      };
    }

    return { status: "pending" };
  }

  /**
   * Helper to check if a single price hits the target/sentiment
   * Now includes percentage thresholds based on asset type
   */
  private checkHit(
    entry: number | null,
    current: number,
    target: number | null,
    sentiment: string,
    assetType: string = "stock"
  ): boolean {
    const sent = sentiment.toLowerCase();

    // 1. Target Price Check (Strict)
    if (target !== null) {
      if (sent === "bullish") return current >= target;
      if (sent === "bearish") return current <= target;
      // If target exists but not met, return false immediately
      return false;
    }

    // 2. Sentiment Threshold Check (if no target)
    if (entry !== null) {
      const type = assetType.toLowerCase();
      let thresholdUp = 0.05; // Default 5%
      let thresholdDown = 0.05; // Default 5%

      // Define thresholds based on asset type
      if (type === "crypto") {
        thresholdUp = 0.1; // +10%
        thresholdDown = 0.05; // -5%
      } else if (type === "stock") {
        thresholdUp = 0.05; // +5%
        thresholdDown = 0.05; // -5%
      } else if (type === "forex") {
        thresholdUp = 0.01; // +1%
        thresholdDown = 0.01; // -1%
      } else if (type === "commodity" || type === "index") {
        thresholdUp = 0.03; // +3%
        thresholdDown = 0.03; // -3%
      }

      if (sent === "bullish") {
        const targetValue = entry * (1 + thresholdUp);
        // Use small epsilon for floating point comparison
        return current >= targetValue - 0.0001;
      }

      if (sent === "bearish") {
        const targetValue = entry * (1 - thresholdDown);
        // Use small epsilon for floating point comparison
        return current <= targetValue + 0.0001;
      }
    }

    return false;
  }

  /**
   * Calculate horizon date based on post date and horizon value
   * @deprecated Use calculateHorizonDateRange instead
   */
  calculateHorizonDate(postDate: Date, horizonValue: string): Date {
    const { end } = this.calculateHorizonDateRange(postDate, horizonValue);
    return end;
  }

  /**
   * Verify prediction accuracy
   * @deprecated Use verifyPredictionWithRange instead
   */
  verifyPrediction(
    entryPrice: number | null,
    horizonPrice: number,
    targetPrice: number | null,
    sentiment: string
  ): "correct" | "wrong" | "pending" {
    return this.checkHit(entryPrice, horizonPrice, targetPrice, sentiment)
      ? "correct"
      : "wrong";
  }
}

export const priceService = new PriceService();
