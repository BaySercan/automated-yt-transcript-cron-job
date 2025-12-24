import axios from "axios";
import { config } from "../config";
import { logger, retryWithBackoff } from "../utils";

/**
 * Asset Classifier Response Structure
 */
export interface AssetClassification {
  assetType: "stock" | "index" | "forex" | "commodity" | "crypto";
  currency: string; // ISO code: USD, TRY, EUR, GBP, JPY, etc.
  normalizedSymbol: string; // Space-less, standardized format
  currencySymbol: string; // Display symbol: €, ₺, £, ¥, ₹, $, ₿, etc. Empty string for indices
  confidence: "high" | "medium" | "low";
  reasoning?: string;
  tradingviewSymbol?: string; // e.g. "NASDAQ:AAPL", "BIST:THYAO", "BINANCE:BTCUSDT"
  exchange?: string; // e.g. "NASDAQ", "BIST", "BINANCE"
}

/**
 * Asset Classifier Service
 * Uses AI to intelligently classify financial assets and detect their currencies
 */
export class AssetClassifierService {
  // In-memory cache for the current execution
  private readonly cache: Map<string, AssetClassification> = new Map();

  // Critical assets with hardcoded fallbacks (when AI fails)
  private readonly FALLBACK_ASSETS: {
    [key: string]: AssetClassification;
  } = {
    // Crypto
    BTC: {
      assetType: "crypto",
      currency: "USD",
      normalizedSymbol: "BTC",
      currencySymbol: "$",
      confidence: "high",
    },
    ETH: {
      assetType: "crypto",
      currency: "USD",
      normalizedSymbol: "ETH",
      currencySymbol: "$",
      confidence: "high",
    },
    SOL: {
      assetType: "crypto",
      currency: "USD",
      normalizedSymbol: "SOL",
      currencySymbol: "$",
      confidence: "high",
    },
    XRP: {
      assetType: "crypto",
      currency: "USD",
      normalizedSymbol: "XRP",
      currencySymbol: "$",
      confidence: "high",
    },
    ADA: {
      assetType: "crypto",
      currency: "USD",
      normalizedSymbol: "ADA",
      currencySymbol: "$",
      confidence: "high",
    },
    DOGE: {
      assetType: "crypto",
      currency: "USD",
      normalizedSymbol: "DOGE",
      currencySymbol: "$",
      confidence: "high",
    },

    // Major Indices (empty symbol for indices)
    SPX: {
      assetType: "index",
      currency: "USD",
      normalizedSymbol: "SPX",
      currencySymbol: "",
      confidence: "high",
    },
    SP500: {
      assetType: "index",
      currency: "USD",
      normalizedSymbol: "SPX",
      currencySymbol: "",
      confidence: "high",
    },
    NDX: {
      assetType: "index",
      currency: "USD",
      normalizedSymbol: "NDX",
      currencySymbol: "",
      confidence: "high",
    },
    NASDAQ: {
      assetType: "index",
      currency: "USD",
      normalizedSymbol: "NDX",
      currencySymbol: "",
      confidence: "high",
    },
    BIST100: {
      assetType: "index",
      currency: "TRY",
      normalizedSymbol: "BIST100",
      currencySymbol: "",
      confidence: "high",
    },
    BIST30: {
      assetType: "index",
      currency: "TRY",
      normalizedSymbol: "BIST30",
      currencySymbol: "",
      confidence: "high",
    },
    BIST75: {
      assetType: "index",
      currency: "TRY",
      normalizedSymbol: "BIST75",
      currencySymbol: "",
      confidence: "high",
    },
    XU100: {
      assetType: "index",
      currency: "TRY",
      normalizedSymbol: "BIST100",
      currencySymbol: "",
      confidence: "high",
    },
    DAX: {
      assetType: "index",
      currency: "EUR",
      normalizedSymbol: "DAX",
      currencySymbol: "",
      confidence: "high",
    },
    FTSE: {
      assetType: "index",
      currency: "GBP",
      normalizedSymbol: "FTSE",
      currencySymbol: "",
      confidence: "high",
    },
    FTSE100: {
      assetType: "index",
      currency: "GBP",
      normalizedSymbol: "FTSE",
      currencySymbol: "",
      confidence: "high",
    },
    NIKKEI: {
      assetType: "index",
      currency: "JPY",
      normalizedSymbol: "N225",
      currencySymbol: "",
      confidence: "high",
    },
    N225: {
      assetType: "index",
      currency: "JPY",
      normalizedSymbol: "N225",
      currencySymbol: "",
      confidence: "high",
    },
    DOW: {
      assetType: "index",
      currency: "USD",
      normalizedSymbol: "DJI",
      currencySymbol: "",
      confidence: "high",
    },

    // Major Forex
    EURUSD: {
      assetType: "forex",
      currency: "USD",
      normalizedSymbol: "EURUSD",
      currencySymbol: "$",
      confidence: "high",
    },
    USDTRY: {
      assetType: "forex",
      currency: "TRY",
      normalizedSymbol: "USDTRY",
      currencySymbol: "₺",
      confidence: "high",
    },
    GBPUSD: {
      assetType: "forex",
      currency: "USD",
      normalizedSymbol: "GBPUSD",
      currencySymbol: "$",
      confidence: "high",
    },
    USDJPY: {
      assetType: "forex",
      currency: "JPY",
      normalizedSymbol: "USDJPY",
      currencySymbol: "¥",
      confidence: "high",
    },
    EURTRY: {
      assetType: "forex",
      currency: "EUR",
      normalizedSymbol: "EURTRY",
      currencySymbol: "€",
      confidence: "high",
    },
    GBPTRY: {
      assetType: "forex",
      currency: "GBP",
      normalizedSymbol: "GBPTRY",
      currencySymbol: "£",
      confidence: "high",
    },

    // Major Commodities
    GOLD: {
      assetType: "commodity",
      currency: "USD",
      normalizedSymbol: "GOLD",
      currencySymbol: "$",
      confidence: "high",
    },
    XAUUSD: {
      assetType: "commodity",
      currency: "USD",
      normalizedSymbol: "XAUUSD",
      currencySymbol: "$",
      confidence: "high",
    },
    XAU: {
      assetType: "commodity",
      currency: "USD",
      normalizedSymbol: "XAUUSD",
      currencySymbol: "$",
      confidence: "high",
    },
    XAUTRYG: {
      assetType: "commodity",
      currency: "TRY",
      normalizedSymbol: "XAUTRYG",
      currencySymbol: "₺",
      confidence: "high",
    },
    SILVER: {
      assetType: "commodity",
      currency: "USD",
      normalizedSymbol: "SILVER",
      currencySymbol: "$",
      confidence: "high",
    },
    CRUDE: {
      assetType: "commodity",
      currency: "USD",
      normalizedSymbol: "CRUDE",
      currencySymbol: "$",
      confidence: "high",
    },
    OIL: {
      assetType: "commodity",
      currency: "USD",
      normalizedSymbol: "CRUDE",
      currencySymbol: "$",
      confidence: "high",
    },
  };

  /**
   * Classify an asset with full prediction context
   * @param assetName The asset name/symbol mentioned in prediction
   * @param predictionText Full prediction text for context
   * @returns Asset classification with type, currency, and symbol
   */
  async classifyAsset(
    assetName: string,
    predictionText: string = ""
  ): Promise<AssetClassification> {
    if (!assetName || assetName.trim().length === 0) {
      return {
        assetType: "stock",
        currency: "USD",
        normalizedSymbol: "UNKNOWN",
        currencySymbol: "$",
        confidence: "low",
        reasoning: "Empty asset name",
      };
    }

    const normalizedKey = assetName.toUpperCase().trim().replace(/\s+/g, "");

    // Check in-memory cache first
    if (this.cache.has(normalizedKey)) {
      logger.debug(`📦 Asset cache hit: ${assetName}`);
      return this.cache.get(normalizedKey)!;
    }

    // Check fallback mapping for critical assets
    if (this.FALLBACK_ASSETS[normalizedKey]) {
      const result = this.FALLBACK_ASSETS[normalizedKey];
      this.cache.set(normalizedKey, result);
      logger.debug(
        `✅ Asset fallback match: ${assetName} → ${result.normalizedSymbol}`
      );
      return result;
    }

    try {
      // Use AI for classification
      logger.info(`🤖 Classifying asset via AI: ${assetName}`, {
        predictionLength: predictionText.length,
      });

      const classification = await retryWithBackoff(
        async () => {
          return this.classifyViaAI(assetName, predictionText);
        },
        2, // Only 2 retries for faster fallback
        1000
      );

      this.cache.set(normalizedKey, classification);
      return classification;
    } catch (error) {
      logger.warn(
        `⚠️ AI classification failed for ${assetName}, using defaults`,
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );

      // Final fallback: default to stock with USD
      const fallback: AssetClassification = {
        assetType: "stock",
        currency: "USD",
        normalizedSymbol: normalizedKey,
        currencySymbol: "$",
        confidence: "low",
        reasoning: "AI classification failed, using default fallback",
      };

      this.cache.set(normalizedKey, fallback);
      return fallback;
    }
  }

  /**
   * Classify asset using AI
   */
  private async classifyViaAI(
    assetName: string,
    predictionText: string
  ): Promise<AssetClassification> {
    const prompt = `You are a financial asset classifier. Analyze the asset name and prediction context, then return a JSON response with the asset classification.

ASSET NAME: ${assetName}

PREDICTION CONTEXT: ${predictionText || "(no context provided)"}

INSTRUCTIONS:
1. Classify the asset into ONE of: stock, index, forex, commodity, crypto
2. Determine the ISO currency code (USD, TRY, EUR, GBP, JPY, INR, CHF, AUD, CAD, etc.)
3. Normalize the symbol to a space-less, uppercase format
4. Determine the appropriate currency display symbol (€, ₺, £, ¥, ₹, $, ₿, CHF, etc.)
   - For INDICES: Return empty string "" (indices show numbers only, no currency symbol)
   - For other assets: Return appropriate symbol for that asset's currency (€ for EUR, ₺ for TRY, £ for GBP, $ for USD, etc.)
5. Provide confidence level: high, medium, or low
7. Identify the TradingView symbol (e.g., "NASDAQ:AAPL", "BIST:THYAO", "BINANCE:BTCUSDT")
8. Identify the Exchange Code (e.g., "NASDAQ", "BIST", "BINANCE", "FX", "TVC")

ASSET TYPE GUIDELINES:
- Stocks: Individual company shares (AAPL, TSLA, MSFT, ASELS, TOASO, SODA, KRDMD, etc.)
- Indices: Market indices (S&P500, BIST100, BIST30, DAX, FTSE, FTSE100, NIKKEI, NASDAQ, DOW, CAC40, SMI, AEX, etc.)
- Forex: Currency pairs (USD/TRY, EUR/USD, GBP/USD, USDJPY, EURTRY, GBPTRY, AUDUSD, NZDUSD, etc.)
- Commodities: Gold, Silver, Oil, Crude, Natural Gas, Brent, WTI, Palladium, Platinum, etc.
- Crypto: Bitcoin, Ethereum, Solana, Ripple, Cardano, Dogecoin, Polkadot, etc.

CURRENCY SYMBOL MAPPING:
- USD → $ (dollar sign)
- EUR → € (euro sign)
- GBP → £ (pound sign)
- JPY → ¥ (yen sign)
- CNY → ¥ (yuan, same as JPY symbol)
- TRY → ₺ (turkish lira)
- INR → ₹ (indian rupee)
- RUB → ₽ (russian ruble)
- KRW → ₩ (korean won)
- AUD → $ (australian dollar, but context matters)
- CAD → $ (canadian dollar, but context matters)
- CHF → CHF (swiss franc)
- SEK → kr (swedish krona)
- NOK → kr (norwegian krone)
- DKK → kr (danish krone)
- BTC → ₿ (bitcoin)

CURRENCY RULES:
- For stocks: Currency of the exchange where traded (US stocks = USD, Turkish = TRY, European = EUR, etc.)
- For indices: Currency of the country (BIST100 = TRY, DAX = EUR, FTSE = GBP, NIKKEI = JPY, S&P500 = USD, CAC40 = EUR, etc.)
- For forex: Base currency is the first currency in the pair (EUR in EURUSD, USD in USDTRY, GBP in GBPUSD)
- For commodities: Usually USD unless context suggests otherwise (most global commodities traded in USD)
- For crypto: Always USD

CRITICAL FOR DISPLAY FORMATTING:
- INDICES must have EMPTY currencySymbol: "" (they show as "2,650" or "22,500" not "₺2,650")
- All other assets must have a symbol: "$", "€", "₺", "£", "¥", "₹", "₿", etc.

EXAMPLES:
- "Apple" → {assetType: "stock", currency: "USD", normalizedSymbol: "AAPL", currencySymbol: "$", tradingviewSymbol: "NASDAQ:AAPL", exchange: "NASDAQ"}
- "BIST 100" or "BIST100" → {assetType: "index", currency: "TRY", normalizedSymbol: "BIST100", currencySymbol: "", tradingviewSymbol: "BIST:XU100", exchange: "BIST"}
- "USD/TRY" → {assetType: "forex", currency: "USD", normalizedSymbol: "USDTRY", currencySymbol: "$", tradingviewSymbol: "FX:USDTRY", exchange: "FX"}
- "EUR/USD" → {assetType: "forex", currency: "EUR", normalizedSymbol: "EURUSD", currencySymbol: "€", tradingviewSymbol: "FX:EURUSD", exchange: "FX"}
- "Gold" or "XAU" → {assetType: "commodity", currency: "USD", normalizedSymbol: "GOLD", currencySymbol: "$", tradingviewSymbol: "TVC:GOLD", exchange: "TVC"}
- "Bitcoin" → {assetType: "crypto", currency: "USD", normalizedSymbol: "BTC", currencySymbol: "₿", tradingviewSymbol: "BINANCE:BTCUSDT", exchange: "BINANCE"}
- "ASELS" (Turkish stock) → {assetType: "stock", currency: "TRY", normalizedSymbol: "ASELS", currencySymbol: "₺", tradingviewSymbol: "BIST:ASELS", exchange: "BIST"}
- "FTSE 100" → {assetType: "index", currency: "GBP", normalizedSymbol: "FTSE", currencySymbol: "", tradingviewSymbol: "TVC:UKX", exchange: "TVC"}
- "DAX" → {assetType: "index", currency: "EUR", normalizedSymbol: "DAX", currencySymbol: "", tradingviewSymbol: "XETR:DAX", exchange: "XETR"}

Return ONLY valid JSON in this exact format:
{
  "assetType": "stock|index|forex|commodity|crypto",
  "currency": "ISO_CODE",
  "normalizedSymbol": "NORMALIZED_SYMBOL",
  "currencySymbol": "SYMBOL_OR_EMPTY_FOR_INDICES",
  "confidence": "high|medium|low",
  "reasoning": "brief explanation of classification",
  "tradingviewSymbol": "EXCHANGE:SYMBOL",
  "exchange": "EXCHANGE_CODE"
}`;

    const models = [config.openrouterModel, config.openrouterModel2].filter(
      (m) => m && typeof m === "string" && m.trim().length > 0
    );

    if (models.length === 0) {
      throw new Error("No OpenRouter model configured");
    }

    let lastError: Error | null = null;

    for (const model of models) {
      try {
        const response = await axios.post(
          `${config.openrouterBaseUrl}/chat/completions`,
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a financial asset classifier. Respond with ONLY valid JSON. No markdown, no code blocks, no explanations.",
              },
              {
                role: "user",
                content: prompt,
              },
            ],
            temperature: 0.2, // Low temperature for consistent classification
            max_tokens: 500, // Small response needed
            response_format: { type: "json_object" },
          },
          {
            headers: {
              Authorization: `Bearer ${config.openrouterApiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://finfluencer-tracker.com",
              "X-Title": "Finfluencer Tracker",
            },
            timeout: config.requestTimeout,
          }
        );

        if (response.status !== 200) {
          throw new Error(`API returned status ${response.status}`);
        }

        const content = response.data?.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("No response content from API");
        }

        const cleaned = this.cleanJsonResponse(content);
        const result = JSON.parse(cleaned) as AssetClassification;

        // Validate required fields
        if (!result.assetType || !result.currency || !result.normalizedSymbol) {
          throw new Error("Invalid classification structure");
        }

        // Ensure currencySymbol is present (can be empty for indices)
        if (result.currencySymbol === undefined) {
          result.currencySymbol = "";
        }

        logger.debug(`✅ AI classified ${assetName}:`, result);
        return result;
      } catch (error) {
        lastError = error as Error;
        logger.debug(`Model ${model} failed for ${assetName}:`, {
          error: (error as Error).message,
        });
        // Continue to next model
      }
    }

    throw lastError || new Error("All models failed to classify asset");
  }

  /**
   * Clean JSON response from AI
   */
  private cleanJsonResponse(content: string): string {
    let cleaned = content.trim();
    cleaned = cleaned.replace(/```json\s*/g, "").replace(/```\s*$/g, "");
    cleaned = cleaned.replace(/```\s*/g, "").replace(/```\s*$/g, "");
    cleaned = cleaned
      .replace(/^(Here is|Here's|The result is|Result:|Output:)\s*/i, "")
      .trim();
    return cleaned;
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug("🗑️ Asset classifier cache cleared");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

// Export singleton instance
export const assetClassifierService = new AssetClassifierService();
