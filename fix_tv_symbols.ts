import "dotenv/config";
import axios from "axios";
import { supabaseService } from "./src/supabase";
import { config } from "./src/config";
import { logger } from "./src/utils";

/**
 * Script to correct TradingView symbols for all assets in combined_predictions
 * Uses AI to determine the correct exchange for each unique asset
 */

interface TVSymbolResponse {
  tradingview_symbol: string;
  exchange: string;
  reasoning: string;
}

async function askAIForTVSymbol(
  asset: string,
  assetType: string | null,
  predictionText: string | null
): Promise<TVSymbolResponse | null> {
  const prompt = `You are a financial data expert. Given an asset name, type, and prediction context, return the correct TradingView symbol.

ASSET: "${asset}"
ASSET TYPE: "${assetType || "unknown"}"
PREDICTION CONTEXT: "${(predictionText || "").slice(0, 200)}"

RULES:
1. For US stocks (asset_type: stock), determine the CORRECT exchange:
   - NYSE stocks: NYSE:SYMBOL (e.g., BABA → NYSE:BABA, HIMS → NYSE:HIMS, ALB → NYSE:ALB, NIO → NYSE:NIO)
   - NASDAQ stocks: NASDAQ:SYMBOL (e.g., AAPL → NASDAQ:AAPL, TSLA → NASDAQ:TSLA, AMD → NASDAQ:AMD)
2. For Turkish stocks (BIST): BIST:SYMBOL (e.g., AKBNK → BIST:AKBNK)
3. For Crypto (asset_type: crypto): BINANCE:SYMBOLUSDT (e.g., BTC → BINANCE:BTCUSDT)
4. For Forex pairs (asset_type: forex): FX:PAIR (e.g., EURUSD → FX:EURUSD)
5. For Indices (asset_type: index): Use proper exchange (e.g., BIST100 → BIST:XU100, SPX → SP:SPX)
6. For Commodities (asset_type: commodity): NYMEX/COMEX (e.g., Gold → COMEX:GC1!, WTI → NYMEX:CL1!)
7. For Hong Kong stocks: HKEX:SYMBOL (e.g., 9988 → HKEX:09988)
8. For Chinese stocks: SSE or SZSE prefix

CRITICAL: Double-check the exchange. Many stocks are commonly misattributed. BABA, HIMS, NIO are NYSE, not NASDAQ.

Return JSON only:
{
  "tradingview_symbol": "EXCHANGE:SYMBOL",
  "exchange": "EXCHANGE_NAME",
  "reasoning": "Brief explanation"
}`;

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: config.openrouterModel2,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${config.openrouterApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    return parsed as TVSymbolResponse;
  } catch (error: any) {
    logger.warn(`AI call failed for ${asset}: ${error.message}`);
    return null;
  }
}

async function fixTradingViewSymbols() {
  logger.info("🚀 Starting TradingView Symbol Correction...");

  try {
    // 1. Fetch all unique assets that have a TV symbol (we want to verify/correct them)
    const { data: records, error } = await supabaseService.supabase
      .from("combined_predictions")
      .select("asset, asset_type, prediction_text")
      .not("tradingview_symbol", "is", null);

    if (error) {
      throw new Error(`Failed to fetch assets: ${error.message}`);
    }

    // Build unique assets map with their asset_type and sample prediction_text
    const assetMap = new Map<
      string,
      { assetType: string | null; predictionText: string | null }
    >();
    records?.forEach((r: any) => {
      if (r.asset && !assetMap.has(r.asset)) {
        assetMap.set(r.asset, {
          assetType: r.asset_type || null,
          predictionText: r.prediction_text || null,
        });
      }
    });
    logger.info(`Found ${assetMap.size} unique assets to verify.`);

    let corrected = 0;
    let unchanged = 0;
    let errors = 0;

    for (const [asset, info] of assetMap.entries()) {
      logger.info(
        `\n🔍 Checking: ${asset} (type: ${info.assetType || "unknown"})`
      );

      // Get current TV symbol
      const { data: current } = await supabaseService.supabase
        .from("combined_predictions")
        .select("tradingview_symbol")
        .eq("asset", asset)
        .limit(1)
        .single();

      const currentSymbol = current?.tradingview_symbol;

      // Ask AI for correct symbol (now with asset type and prediction context)
      const aiResult = await askAIForTVSymbol(
        asset,
        info.assetType,
        info.predictionText
      );

      if (!aiResult) {
        logger.warn(`   ⚠️ AI failed for ${asset}, keeping current value`);
        errors++;
        continue;
      }

      const newSymbol = aiResult.tradingview_symbol;

      if (currentSymbol === newSymbol) {
        logger.info(`   ✅ Already correct: ${currentSymbol}`);
        unchanged++;
      } else {
        // Update all rows with this asset
        const { error: updateError } = await supabaseService.supabase
          .from("combined_predictions")
          .update({ tradingview_symbol: newSymbol })
          .eq("asset", asset);

        if (updateError) {
          logger.error(`   ❌ Update failed: ${updateError.message}`);
          errors++;
        } else {
          logger.info(
            `   🔄 Corrected: ${currentSymbol} → ${newSymbol} (${aiResult.reasoning})`
          );
          corrected++;
        }
      }

      // Rate limiting
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log("\n========================================");
    logger.info("🎉 Correction Complete!");
    logger.info(`Total Assets: ${assetMap.size}`);
    logger.info(`Corrected: ${corrected}`);
    logger.info(`Unchanged: ${unchanged}`);
    logger.info(`Errors: ${errors}`);
  } catch (err: any) {
    logger.error("Fatal error in fix script", { error: err.message });
  }
}

// Run
fixTradingViewSymbols();
