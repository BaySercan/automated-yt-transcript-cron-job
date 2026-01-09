/**
 * Process Legacy Pending Predictions
 *
 * One-time script to process pending predictions that:
 * - Have never been AI verified (ai_verification_at IS NULL)
 * - Have passed horizons (horizon_end_date < now())
 *
 * Usage:
 *   # Dry run (preview only)
 *   npx ts-node scripts/processLegacyPending.ts --limit=10
 *
 *   # Process with offset
 *   npx ts-node scripts/processLegacyPending.ts --limit=50 --offset=100
 *
 *   # Apply changes to database
 *   npx ts-node scripts/processLegacyPending.ts --limit=50 --apply
 */

import { supabaseService } from "../src/supabase";
import { aiVerificationService } from "../src/services/aiVerificationService";
import { logger } from "../src/utils";

interface ProcessOptions {
  limit: number;
  offset: number;
  apply: boolean;
}

async function processLegacyPending(options: ProcessOptions): Promise<void> {
  const { limit, offset, apply } = options;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`🧹 Processing Legacy Pending Predictions`);
  console.log(`   Limit: ${limit}, Offset: ${offset}`);
  console.log(`   Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`${"=".repeat(70)}\n`);

  // Fetch legacy pending predictions with passed horizons
  const now = new Date().toISOString();
  const { data: predictions, error } = await supabaseService.supabase
    .from("combined_predictions")
    .select("id, asset, sentiment, horizon_value, horizon_end_date, status")
    .eq("status", "pending")
    .is("ai_verification_at", null)
    .lt("horizon_end_date", now)
    .order("horizon_end_date", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("❌ Failed to fetch predictions:", error);
    return;
  }

  if (!predictions || predictions.length === 0) {
    console.log("✅ No legacy pending predictions found!");
    return;
  }

  console.log(`Found ${predictions.length} legacy pending predictions\n`);

  const results = {
    total: predictions.length,
    success: 0,
    failed: 0,
    correct: 0,
    wrong: 0,
    pending: 0,
    entryPricesSaved: 0,
  };

  const startTime = Date.now();

  for (let i = 0; i < predictions.length; i++) {
    const pred = predictions[i];
    const elapsed = (Date.now() - startTime) / 1000;
    const avgTime = elapsed / (i + 1);
    const remaining = avgTime * (predictions.length - i - 1);

    console.log(
      `\n[${i + 1}/${predictions.length}] ${pred.asset} - ${pred.sentiment}`
    );
    console.log(
      `   Horizon: "${pred.horizon_value}" (ended: ${pred.horizon_end_date})`
    );
    console.log(`   ETA: ${Math.round(remaining)}s remaining`);

    try {
      if (apply) {
        const { success, result } = await aiVerificationService.verifyAndApply(
          pred.id
        );

        if (success && result) {
          results.success++;
          if (result.status === "correct") results.correct++;
          if (result.status === "wrong") results.wrong++;
          if (result.status === "pending") results.pending++;

          console.log(
            `   ✅ ${result.status.toUpperCase()} (${result.confidence})`
          );
          console.log(`   💬 ${result.reasoning.slice(0, 100)}...`);
        } else {
          results.failed++;
          console.log(`   ❌ Failed to verify`);
        }
      } else {
        // Dry run - just gather context and verify
        const context = await aiVerificationService.gatherContext(pred.id);
        if (!context) {
          results.failed++;
          console.log(`   ❌ Failed to gather context`);
          continue;
        }

        const result = await aiVerificationService.verifyPrediction(context);
        if (result) {
          results.success++;
          if (result.status === "correct") results.correct++;
          if (result.status === "wrong") results.wrong++;
          if (result.status === "pending") results.pending++;

          console.log(
            `   ✅ Would be: ${result.status.toUpperCase()} (${
              result.confidence
            })`
          );
          console.log(`   💬 ${result.reasoning.slice(0, 100)}...`);
        } else {
          results.failed++;
          console.log(`   ❌ Failed to verify`);
        }
      }
    } catch (err: any) {
      results.failed++;
      console.log(`   ❌ Error: ${err.message || err}`);
    }

    // Small delay between predictions to avoid rate limits
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📊 SUMMARY`);
  console.log(`Total processed: ${results.total}`);
  console.log(`Success: ${results.success}, Failed: ${results.failed}`);
  console.log(`\nResults:`);
  console.log(`  Correct: ${results.correct}`);
  console.log(`  Wrong: ${results.wrong}`);
  console.log(`  Pending: ${results.pending}`);
  console.log(`\nTime: ${totalTime}s`);
  console.log(`${"=".repeat(70)}`);

  if (!apply) {
    console.log(`\n⚠️  DRY RUN - Use --apply to save results`);
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  const options: ProcessOptions = {
    limit: 50,
    offset: 0,
    apply: args.includes("--apply"),
  };

  // Parse --limit
  const limitArg = args.find((a) => a.startsWith("--limit="));
  if (limitArg) {
    options.limit = parseInt(limitArg.split("=")[1] || "50");
  }

  // Parse --offset
  const offsetArg = args.find((a) => a.startsWith("--offset="));
  if (offsetArg) {
    options.offset = parseInt(offsetArg.split("=")[1] || "0");
  }

  await processLegacyPending(options);
}

if (require.main === module) {
  main()
    .then(() => {
      console.log("\n✅ Processing completed");
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n❌ Processing failed:", err);
      process.exit(1);
    });
}
