/**
 * AI Verification Test Script
 *
 * Tests the new AI-driven verification service on sample predictions.
 *
 * Usage:
 *   # Test single prediction by ID
 *   npx ts-node scripts/testAiVerification.ts --id=<prediction_id>
 *
 *   # Test batch of pending predictions
 *   npx ts-node scripts/testAiVerification.ts --limit=5
 *
 *   # Test with offset for pagination
 *   npx ts-node scripts/testAiVerification.ts --limit=100 --offset=200
 *
 *   # Test and apply results (not dry-run)
 *   npx ts-node scripts/testAiVerification.ts --limit=5 --apply
 */

import { supabaseService } from "../src/supabase";
import { aiVerificationService } from "../src/services/aiVerificationService";
import { logger } from "../src/utils";

interface TestOptions {
  predictionId?: string;
  limit: number;
  offset: number;
  apply: boolean;
}

async function testSinglePrediction(
  predictionId: string,
  apply: boolean
): Promise<void> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`🧪 Testing AI Verification for prediction: ${predictionId}`);
  console.log(`${"=".repeat(70)}\n`);

  // 1. Gather context
  console.log("📋 Gathering context...");
  const context = await aiVerificationService.gatherContext(predictionId);

  if (!context) {
    console.error("❌ Failed to gather context");
    return;
  }

  console.log(`\n--- PREDICTION CONTEXT ---`);
  console.log(
    `Asset: ${context.prediction.asset} (${context.prediction.assetType})`
  );
  console.log(`Sentiment: ${context.prediction.sentiment}`);
  console.log(
    `Target Price: ${context.prediction.targetPrice || "Not specified"}`
  );
  console.log(`Horizon: "${context.prediction.horizonValue}"`);
  console.log(`Post Date: ${context.video.postDate}`);
  console.log(
    `Current Horizon: ${context.currentHorizon.horizonStart} → ${context.currentHorizon.horizonEnd}`
  );
  console.log(
    `Has Transcript: ${context.rawTranscript ? "Yes" : "No"} ${
      context.rawTranscript ? `(${context.rawTranscript.length} chars)` : ""
    }`
  );
  console.log(`Price Points: ${context.prices.priceHistory.length}`);
  console.log(`Entry Price: ${context.prices.entryPrice}`);
  console.log(`Current Price: ${context.prices.currentPrice}`);
  console.log(
    `Price Change: ${context.prices.priceChangePercent?.toFixed(2) || "N/A"}%`
  );

  console.log(`\n--- PREDICTION TEXT ---`);
  console.log(`"${context.prediction.predictionText}"`);

  // 2. Run AI verification
  console.log(`\n🤖 Running AI verification...`);
  const startTime = Date.now();
  const result = await aiVerificationService.verifyPrediction(context);
  const elapsed = Date.now() - startTime;

  if (!result) {
    console.error("❌ AI verification failed");
    return;
  }

  console.log(`\n--- AI RESULT (${elapsed}ms) ---`);
  console.log(`Status: ${result.status.toUpperCase()}`);
  console.log(`Confidence: ${result.confidence}`);
  console.log(`Reasoning: ${result.reasoning}`);

  console.log(`\n--- HORIZON ANALYSIS ---`);
  console.log(`Was Corrected: ${result.correctedHorizon.wasCorrected}`);
  console.log(`Corrected Start: ${result.correctedHorizon.horizonStart}`);
  console.log(`Corrected End: ${result.correctedHorizon.horizonEnd}`);
  if (result.correctedHorizon.correctionReason) {
    console.log(
      `Correction Reason: ${result.correctedHorizon.correctionReason}`
    );
  }

  console.log(`\n--- INTERPRETATION ---`);
  console.log(`Target: ${result.interpretation.interpretedTarget}`);
  console.log(`Success Criteria: ${result.interpretation.successCriteria}`);

  console.log(`\n--- EVIDENCE ---`);
  console.log(`Target Met: ${result.evidence.targetMet}`);
  console.log(`Target Met Date: ${result.evidence.targetMetDate || "N/A"}`);
  console.log(`Highest Price: ${result.evidence.highestPrice}`);
  console.log(`Lowest Price: ${result.evidence.lowestPrice}`);

  console.log(`\n--- FLAGS ---`);
  console.log(`Hedged Language: ${result.flags.hedgedLanguage}`);
  console.log(`Conditional Prediction: ${result.flags.conditionalPrediction}`);
  console.log(`Conditions Met: ${result.flags.conditionsMet}`);

  console.log(`\n--- CORRECTIONS ---`);
  console.log(
    `Prediction Text Corrected: ${result.corrections.predictionTextWasCorrected}`
  );
  if (result.corrections.correctedPredictionText) {
    console.log(
      `Corrected Text: "${result.corrections.correctedPredictionText}"`
    );
    console.log(
      `Correction Reason: ${result.corrections.predictionTextCorrectionReason}`
    );
  }
  console.log(
    `Asset Type Corrected: ${result.corrections.assetTypeWasCorrected}`
  );
  if (result.corrections.correctedAssetType) {
    console.log(`Corrected Type: ${result.corrections.correctedAssetType}`);
    console.log(
      `Type Correction Reason: ${result.corrections.assetTypeCorrectionReason}`
    );
  }
  console.log(
    `Horizon Value Corrected: ${result.corrections.horizonValueWasCorrected}`
  );
  if (result.corrections.correctedHorizonValue) {
    console.log(
      `Corrected Horizon: ${result.corrections.correctedHorizonValue}`
    );
    console.log(
      `Horizon Correction Reason: ${result.corrections.horizonValueCorrectionReason}`
    );
  }

  // 3. Apply results if not dry-run
  if (apply) {
    console.log(`\n💾 Applying results to database...`);
    const applied = await aiVerificationService.applyVerificationResult(
      predictionId,
      result,
      context.prices.priceHistory
    );
    console.log(applied ? "✅ Applied successfully" : "❌ Failed to apply");
  } else {
    console.log(`\n⚠️  DRY RUN - Use --apply to save results`);
  }
}

async function testBatch(
  limit: number,
  offset: number,
  apply: boolean
): Promise<void> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `🧪 Testing AI Verification on ${limit} predictions (offset: ${offset})`
  );
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`${"=".repeat(70)}\n`);

  // Fetch predictions (all statuses)
  const { data: predictions, error } = await supabaseService.supabase
    .from("combined_predictions")
    .select("id, asset, sentiment, horizon_value, status")
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error || !predictions) {
    console.error("❌ Failed to fetch predictions:", error);
    return;
  }

  console.log(`Found ${predictions.length} pending predictions\n`);

  const results = {
    total: predictions.length,
    success: 0,
    failed: 0,
    correct: 0,
    wrong: 0,
    pending: 0,
    horizonCorrected: 0,
  };

  for (let i = 0; i < predictions.length; i++) {
    const pred = predictions[i];
    console.log(
      `\n[${i + 1}/${predictions.length}] ${pred.asset} - ${pred.sentiment}`
    );
    console.log(`   Horizon: "${pred.horizon_value}"`);

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
          if (result.correctedHorizon.wasCorrected) results.horizonCorrected++;

          console.log(
            `   ✅ ${result.status.toUpperCase()} (${result.confidence})`
          );
          if (result.correctedHorizon.wasCorrected) {
            console.log(
              `   📅 Horizon corrected: ${result.correctedHorizon.horizonEnd}`
            );
          }
          console.log(`   💬 ${result.reasoning.slice(0, 100)}...`);
        } else {
          results.failed++;
          console.log(`   ❌ Failed`);
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
          if (result.correctedHorizon.wasCorrected) results.horizonCorrected++;

          console.log(
            `   🔍 ${result.status.toUpperCase()} (${result.confidence})`
          );
          if (result.correctedHorizon.wasCorrected) {
            console.log(
              `   📅 Would correct horizon: ${result.correctedHorizon.horizonEnd}`
            );
          }
          console.log(`   💬 ${result.reasoning.slice(0, 100)}...`);
        } else {
          results.failed++;
          console.log(`   ❌ AI verification failed`);
        }
      }
    } catch (err) {
      results.failed++;
      console.log(`   ❌ Error: ${(err as Error).message}`);
    }

    // Small delay between predictions
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Print summary
  console.log(`\n${"=".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${"=".repeat(70)}`);
  console.log(`Total: ${results.total}`);
  console.log(`Success: ${results.success}`);
  console.log(`Failed: ${results.failed}`);
  console.log(`\nResults:`);
  console.log(`  Correct: ${results.correct}`);
  console.log(`  Wrong: ${results.wrong}`);
  console.log(`  Pending: ${results.pending}`);
  console.log(`  Horizons Corrected: ${results.horizonCorrected}`);
  console.log(`${"=".repeat(70)}`);
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  const options: TestOptions = {
    limit: 5,
    offset: 0,
    apply: args.includes("--apply"),
  };

  // Parse --id
  const idArg = args.find((a) => a.startsWith("--id="));
  if (idArg) {
    options.predictionId = idArg.split("=")[1];
  }

  // Parse --limit
  const limitArg = args.find((a) => a.startsWith("--limit="));
  if (limitArg) {
    options.limit = parseInt(limitArg.split("=")[1] || "5");
  }

  // Parse --offset
  const offsetArg = args.find((a) => a.startsWith("--offset="));
  if (offsetArg) {
    options.offset = parseInt(offsetArg.split("=")[1] || "0");
  }

  console.log(`\n🚀 AI Verification Test Script`);
  console.log(
    `   Apply: ${options.apply}, Limit: ${options.limit}, Offset: ${options.offset}`
  );

  if (options.predictionId) {
    await testSinglePrediction(options.predictionId, options.apply);
  } else {
    await testBatch(options.limit, options.offset, options.apply);
  }
}

if (require.main === module) {
  main()
    .then(() => {
      console.log("\n✅ Test completed");
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n❌ Test failed:", err);
      process.exit(1);
    });
}
