import "dotenv/config";
import { supabaseService } from "../src/supabase";
import { assetClassifierService } from "../src/services/assetClassifierService";
import { priceService } from "../src/services/priceService";
import { logger } from "../src/utils";

async function backfillTradingViewSymbols() {
  logger.info("🚀 Starting TradingView Symbol Backfill...");

  try {
    // 1. Fetch all records where tradingview_symbol is NULL
    // We fetch asset and a sample prediction_text for context
    const { data: records, error } = await supabaseService.supabase
      .from("combined_predictions")
      .select("asset, prediction_text")
      .is("tradingview_symbol", null);

    if (error) {
      throw new Error(`Failed to fetch records: ${error.message}`);
    }

    if (!records || records.length === 0) {
      logger.info("✅ No records found needing backfill.");
      return;
    }

    logger.info(`Found ${records.length} records to process.`);

    // 2. Identify Unique Assets to process efficiently
    // Map: AssetName -> SampleContext
    const uniqueAssets = new Map<string, string>();
    records.forEach((r: any) => {
      if (r.asset && !uniqueAssets.has(r.asset)) {
        uniqueAssets.set(r.asset, r.prediction_text || "");
      }
    });

    logger.info(`Identified ${uniqueAssets.size} unique assets to resolve.`);

    let processed = 0;
    let updated = 0;
    let errors = 0;

    // 3. Process each unique asset
    for (const [asset, context] of uniqueAssets.entries()) {
      logger.info(`\n🔍 Resolving: ${asset}...`);

      let tvSymbol: string | null = null;
      let exchange: string | undefined;

      // A. Try AI Classification first
      try {
        const classification = await assetClassifierService.classifyAsset(
          asset,
          context
        );

        if (classification.tradingviewSymbol) {
          tvSymbol = classification.tradingviewSymbol;
          exchange = classification.exchange;
          logger.info(
            `   🤖 AI identified: ${tvSymbol} (${exchange || "No Exch"})`
          );
        }
      } catch (aiError: any) {
        logger.warn(`   ⚠️ AI failed for ${asset}: ${aiError.message}`);
      }

      // B. Fallback to Algorithmic Mapping if AI failed or returned nothing
      if (!tvSymbol) {
        try {
          // Try to resolve Yahoo ticker to get exchange info if possible
          const yahooTicker = await priceService["resolveYahooTicker"](asset); // accessing private via string index for script

          // If we could do a search, we'd get exchange.
          // For this raw backfill, let's try direct mapping first.
          tvSymbol = priceService.mapToTradingViewSymbol(yahooTicker);
          logger.info(`   🧮 Algo mapped to: ${tvSymbol}`);
        } catch (algoError: any) {
          logger.warn(`   ⚠️ Algo failed for ${asset}: ${algoError.message}`);
        }
      }

      // 4. Update Database for ALL rows with this asset
      if (tvSymbol) {
        const { error: updateError } = await supabaseService.supabase
          .from("combined_predictions")
          .update({ tradingview_symbol: tvSymbol })
          .eq("asset", asset);

        if (updateError) {
          logger.error(
            `   ❌ Failed to update ${asset}: ${updateError.message}`
          );
          errors++;
        } else {
          logger.info(
            `   ✅ Updated database for asset: ${asset} -> ${tvSymbol}`
          );
          updated++;
        }
      } else {
        logger.warn(`   ??? Could not resolve TV Symbol for ${asset}`);
        errors++;
      }

      processed++;
      // Sleep slightly to avoid rate limits
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log("\n-----------------------------------");
    logger.info("🎉 Backfill Completed.");
    logger.info(`Unique Assets Processed: ${processed}`);
    logger.info(`Assets Updated: ${updated}`);
    logger.info(`Errors/Unresolved: ${errors}`);
  } catch (err: any) {
    logger.error("Fatal Error in backfill script", { error: err.message });
  }
}

// Run
backfillTradingViewSymbols();
