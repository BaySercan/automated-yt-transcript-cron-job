import { combinedPredictionsService } from "../src/combinedPredictionsService";
import { logger } from "../src/utils";
import { config, validateConfig } from "../src/config";
import { supabaseService } from "../src/supabase";

async function main() {
  try {
    console.log("🚀 Starting Combined Predictions Reprocessing Script");

    validateConfig();

    // Test Supabase connection
    await supabaseService.testConnection();
    console.log("✅ Supabase connection successful");

    console.log("🔀 Starting combined predictions processing (ALL records)");

    const BATCH_SIZE = 100; // Smaller batch size for script to show progress more frequently
    let totalProcessed = 0;
    let totalInserted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalPricesFetched = 0;
    let batchNumber = 0;
    let hasMoreRecords = true;

    // Loop until all unprocessed predictions are handled
    while (hasMoreRecords) {
      batchNumber++;
      const batchRequestId = `manual_reprocess_${Date.now()}_batch${batchNumber}`;

      console.log(
        `📦 Processing batch ${batchNumber} (Size: ${BATCH_SIZE})...`
      );

      const result = await combinedPredictionsService.processPredictions({
        limit: BATCH_SIZE,
        skipPrice: false,
        dryRun: false,
        concurrency: 5, // Slightly higher concurrency for manual run
        retryCount: 3,
        requestId: batchRequestId,
      });

      totalProcessed += result.processed_records;
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
      totalErrors += result.errors;
      totalPricesFetched += result.prices_fetched;

      console.log(`✅ Batch ${batchNumber} completed:`);
      console.log(`   Processed: ${result.processed_records}`);
      console.log(`   Inserted:  ${result.inserted}`);
      console.log(`   Skipped:   ${result.skipped}`);
      console.log(`   Errors:    ${result.errors}`);
      console.log(`   Total So Far: ${totalProcessed}`);

      // If we processed fewer records than batch size, we're done
      if (result.processed_records < BATCH_SIZE) {
        hasMoreRecords = false;
      }

      // Small delay between batches
      if (hasMoreRecords) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log("\n===========================================");
    console.log("🎉 Reprocessing Completed Successfully");
    console.log("===========================================");
    console.log(`Total Batches:   ${batchNumber}`);
    console.log(`Total Processed: ${totalProcessed}`);
    console.log(`Total Inserted:  ${totalInserted}`);
    console.log(`Total Skipped:   ${totalSkipped}`);
    console.log(`Total Errors:    ${totalErrors}`);
    console.log("===========================================");

    process.exit(0);
  } catch (error) {
    console.error("❌ Script failed", error);
    process.exit(1);
  }
}

main();
