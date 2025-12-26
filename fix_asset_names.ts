import "dotenv/config";
import axios from "axios";
import { supabaseService } from "./src/supabase";
import { config } from "./src/config";
import { logger } from "./src/utils";

/**
 * Script to normalize asset names in combined_predictions
 * Converts company names to proper tickers (ROBINHOOD → HOOD, TESLA → TSLA)
 */

interface AssetNormalizationResponse {
  normalized_ticker: string;
  is_ticker: boolean;
  reasoning: string;
}

async function askAIForNormalizedTicker(
  asset: string,
  assetType: string | null,
  predictionText: string | null
): Promise<AssetNormalizationResponse | null> {
  const prompt = `You are a financial data expert. Given an asset name, determine the correct ticker symbol.

ASSET NAME: "${asset}"
ASSET TYPE: "${assetType || "unknown"}"
PREDICTION CONTEXT: "${(predictionText || "").slice(0, 300)}"

TASK:
1. If the asset is already a proper ticker (AAPL, TSLA, HOOD), return it as-is
2. If the asset is a company name, convert to ticker (ROBINHOOD → HOOD, TESLA → TSLA, AMAZON → AMZN)
3. For Turkish stocks, use standard BIST tickers (AKBANK → AKBNK, GARANTI BANKASI → GARAN)
4. For crypto, use standard symbols (BITCOIN → BTC, ETHEREUM → ETH, DOGECOIN → DOGE)
5. For forex pairs, normalize format (EURO/USD → EURUSD, EUR/TRY → EURTRY)
6. For indices, use standard codes (BIST 100 → BIST100, S&P 500 → SPX)
7. For private companies without tickers (SPACEX, STRIPE), keep the name uppercase

IMPORTANT: 
- Always uppercase
- No spaces in output
- For stocks, must be the actual trading ticker

Return JSON only:
{
  "normalized_ticker": "TICKER",
  "is_ticker": true/false,
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
    return parsed as AssetNormalizationResponse;
  } catch (error: any) {
    logger.warn(`AI call failed for ${asset}: ${error.message}`);
    return null;
  }
}

async function fixAssetNames() {
  logger.info("🚀 Starting Asset Name Normalization...");

  try {
    // 1. Fetch all unique assets with sample data
    const { data: records, error } = await supabaseService.supabase
      .from("combined_predictions")
      .select("asset, asset_type, prediction_text");

    if (error) {
      throw new Error(`Failed to fetch assets: ${error.message}`);
    }

    // Build unique assets map
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
    logger.info(`Found ${assetMap.size} unique assets to check.`);

    let normalized = 0;
    let unchanged = 0;
    let errors = 0;

    for (const [asset, info] of assetMap.entries()) {
      logger.info(`\n🔍 Checking: ${asset}`);

      // Ask AI for normalized ticker
      const aiResult = await askAIForNormalizedTicker(
        asset,
        info.assetType,
        info.predictionText
      );

      if (!aiResult) {
        logger.warn(`   ⚠️ AI failed for ${asset}, keeping current value`);
        errors++;
        continue;
      }

      const newName = aiResult.normalized_ticker;

      if (asset === newName) {
        logger.info(`   ✅ Already normalized: ${asset}`);
        unchanged++;
      } else {
        // Check if the new name already exists (merge needed)
        const { data: existingRows } = await supabaseService.supabase
          .from("combined_predictions")
          .select("id")
          .eq("asset", newName)
          .limit(1);

        if (existingRows && existingRows.length > 0) {
          logger.warn(
            `   ⚡ ${newName} already exists - merging ${asset} into it`
          );
        }

        // Update all rows with this asset to the normalized name
        const { error: updateError } = await supabaseService.supabase
          .from("combined_predictions")
          .update({ asset: newName })
          .eq("asset", asset);

        if (updateError) {
          logger.error(`   ❌ Update failed: ${updateError.message}`);
          errors++;
        } else {
          logger.info(
            `   🔄 Normalized: ${asset} → ${newName} (${aiResult.reasoning})`
          );
          normalized++;
        }
      }

      // Rate limiting
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log("\n========================================");
    logger.info("🎉 Normalization Complete!");
    logger.info(`Total Assets: ${assetMap.size}`);
    logger.info(`Normalized: ${normalized}`);
    logger.info(`Unchanged: ${unchanged}`);
    logger.info(`Errors: ${errors}`);
  } catch (err: any) {
    logger.error("Fatal error in fix script", { error: err.message });
  }
}

// Run
fixAssetNames();
