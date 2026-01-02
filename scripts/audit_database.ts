import "dotenv/config";
import { supabaseService } from "../src/supabase";
import { logger } from "../src/utils";

/**
 * Script to audit database records and assign quality scores
 */

const MIN_SCORE_THRESHOLD = 20;

function calculateScore(pred: any): { total: number; breakdown: any } {
  const breakdown: any = {};
  let total = 0;

  // 1. Directional sentiment (+25)
  const sentiment = (pred.sentiment || "").toLowerCase();
  if (sentiment === "bullish" || sentiment === "bearish") {
    breakdown.direction = 25;
    total += 25;
  }

  // 2. Horizon (+15)
  const horizonValue = pred.horizon?.value || pred.horizon_value;
  if (horizonValue && horizonValue !== "" && horizonValue !== "unknown") {
    breakdown.horizon = 15;
    total += 15;
  }

  // 3. Target Price (+15 bonus)
  const targetPrice = pred.target_price;
  if (
    targetPrice !== null &&
    targetPrice !== undefined &&
    targetPrice !== "" &&
    targetPrice !== "null"
  ) {
    breakdown.targetPrice = 15;
    total += 15;
  }

  // 4. Necessary Conditions (+10)
  const conditions =
    pred.necessary_conditions_for_prediction || pred.conditions;
  if (
    conditions &&
    conditions !== "" &&
    conditions !== "null" &&
    conditions !== "None"
  ) {
    breakdown.conditions = 10;
    total += 10;
  }

  // 5. Confidence (+5)
  const confidence = (pred.confidence || "").toLowerCase();
  if (confidence === "high" || confidence === "medium") {
    breakdown.confidence = 5;
    total += 5;
  }

  return { total, breakdown };
}

async function auditCombinedPredictions() {
  logger.info("🚀 Auditing combined_predictions...");

  const { data: records, error } = await supabaseService.supabase
    .from("combined_predictions")
    .select("*");

  if (error) throw error;
  if (!records) return;

  logger.info(`Found ${records.length} records to process.`);

  let updatedCount = 0;
  let batchSize = 25; // Smaller batch for stability

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (row) => {
        const { total, breakdown } = calculateScore(row);
        const { error: updateError } = await supabaseService.supabase
          .from("combined_predictions")
          .update({ quality_score: total, quality_breakdown: breakdown })
          .eq("id", row.id);

        if (updateError) {
          logger.error(
            `Failed to update combined_prediction ${row.id}: ${updateError.message}`
          );
        }
      })
    );

    updatedCount += batch.length;
    if (updatedCount % 500 === 0 || updatedCount === records.length) {
      logger.info(
        `Processed ${updatedCount}/${records.length} combined records...`
      );
    }
  }

  logger.info(
    `✅ Finished combined_predictions. Updated ${updatedCount} rows.`
  );
}

async function auditFinfluencerPredictions() {
  logger.info("🚀 Auditing finfluencer_predictions...");

  const { data: records, error } = await supabaseService.supabase
    .from("finfluencer_predictions")
    .select("id, video_id, predictions");

  if (error) throw error;
  if (!records) return;

  logger.info(`Found ${records.length} videos to process.`);

  let updatedCount = 0;

  for (const row of records) {
    const predictions = row.predictions || [];
    if (!Array.isArray(predictions)) continue;

    let maxScore = 0;
    const detailedScores = [];

    for (const pred of predictions) {
      const { total, breakdown } = calculateScore(pred);
      detailedScores.push({ asset: pred.asset, score: total, breakdown });
      if (total > maxScore) {
        maxScore = total;
      }
    }

    const { error: updateError } = await supabaseService.supabase
      .from("finfluencer_predictions")
      .update({
        quality_score: maxScore,
        quality_breakdown: {
          max_score: maxScore,
          detailed: detailedScores,
          prediction_count: predictions.length,
          good_predictions: detailedScores.filter(
            (s) => s.score >= MIN_SCORE_THRESHOLD
          ).length,
        },
      })
      .eq("id", row.id);

    if (updateError) {
      logger.error(
        `Failed to update finfluencer_prediction for ${row.video_id}: ${updateError.message}`
      );
    }

    updatedCount++;
    if (updatedCount % 100 === 0 || updatedCount === records.length) {
      logger.info(
        `Processed ${updatedCount}/${records.length} video records...`
      );
    }
  }

  logger.info(
    `✅ Finished finfluencer_predictions. Updated ${updatedCount} rows.`
  );
}

async function runAudit() {
  try {
    await auditCombinedPredictions();
    await auditFinfluencerPredictions();
    logger.info("🎉 Database Audit Complete!");
  } catch (err) {
    logger.error("Audit failed", { error: err });
  }
}

runAudit();
