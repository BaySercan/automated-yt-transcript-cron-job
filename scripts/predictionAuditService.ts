import { supabaseService } from "../src/supabase";
import { logger } from "../src/utils";

/**
 * Prediction Audit Tool
 *
 * Identifies and resets problematic combined_predictions records:
 * 1. Prematurely closed long-term predictions (year/yıl in horizon but closed in <30 days)
 * 2. Target price not reached but marked as correct/wrong
 * 3. Nonsensical horizon values
 *
 * Can be called programmatically or via index.ts
 */

interface AuditRecord {
  id: string;
  video_id: string;
  asset: string;
  horizon_value: string | null;
  post_date: string;
  resolved_at: string | null;
  status: string;
  target_price: string | null;
  actual_price: string | null;
  sentiment: string;
  reason: string;
}

interface AuditResult {
  totalScanned: number;
  toReset: AuditRecord[];
  toDelete: AuditRecord[];
}

export class PredictionAuditService {
  /**
   * Scan predictions for issues
   */
  async scanPredictions(limit: number = 2000): Promise<AuditResult> {
    logger.info(`Scanning predictions for audit (limit: ${limit})...`);

    const toReset: AuditRecord[] = [];
    const toDelete: AuditRecord[] = [];

    const { data: predictions, error } = await supabaseService.supabase
      .from("combined_predictions")
      .select(
        "id, video_id, asset, horizon_value, horizon_type, post_date, resolved_at, status, target_price, actual_price, sentiment, prediction_text"
      )
      .in("status", ["correct", "wrong"])
      .order("resolved_at", { ascending: false })
      .limit(limit);

    if (error) {
      logger.error("Failed to fetch predictions", { error });
      return { totalScanned: 0, toReset: [], toDelete: [] };
    }

    logger.info(`Fetched ${predictions?.length || 0} resolved predictions`);

    for (const pred of predictions || []) {
      const horizonValue = (pred.horizon_value || "").toLowerCase();
      const postDate = new Date(pred.post_date);
      const resolvedAt = pred.resolved_at ? new Date(pred.resolved_at) : null;

      const daysBetween = resolvedAt
        ? Math.floor(
            (resolvedAt.getTime() - postDate.getTime()) / (1000 * 60 * 60 * 24)
          )
        : null;

      // RULE 1: Long-term horizon closed too quickly
      const isLongTermHorizon =
        horizonValue.includes("year") ||
        horizonValue.includes("yıl") ||
        horizonValue.includes("yil") ||
        horizonValue.includes("gelecek") ||
        horizonValue.includes("2026") ||
        horizonValue.includes("2027");

      if (isLongTermHorizon && daysBetween !== null && daysBetween < 30) {
        toReset.push({
          id: pred.id,
          video_id: pred.video_id,
          asset: pred.asset,
          horizon_value: pred.horizon_value,
          post_date: pred.post_date,
          resolved_at: pred.resolved_at,
          status: pred.status,
          target_price: pred.target_price,
          actual_price: pred.actual_price,
          sentiment: pred.sentiment,
          reason: `Long-term horizon closed in ${daysBetween} days`,
        });
        continue;
      }

      // RULE 2: Target price exists but not reached
      if (pred.status === "correct" && pred.target_price && pred.actual_price) {
        const target = parseFloat(pred.target_price);
        const actual = parseFloat(pred.actual_price);
        const sentiment = (pred.sentiment || "").toLowerCase();

        let targetNotMet = false;
        if (sentiment === "bullish" && actual < target * 0.99) {
          targetNotMet = true;
        } else if (sentiment === "bearish" && actual > target * 1.01) {
          targetNotMet = true;
        }

        if (targetNotMet) {
          toReset.push({
            id: pred.id,
            video_id: pred.video_id,
            asset: pred.asset,
            horizon_value: pred.horizon_value,
            post_date: pred.post_date,
            resolved_at: pred.resolved_at,
            status: pred.status,
            target_price: pred.target_price,
            actual_price: pred.actual_price,
            sentiment: pred.sentiment,
            reason: `Target ${target} not met (actual: ${actual})`,
          });
          continue;
        }
      }

      // RULE 3: Nonsensical horizon values
      const nonsensicalPatterns = [
        "sürebileceği",
        "olabilir",
        "gelebilir",
        "yapabilir",
        "düşebilir",
        "çıkabilir",
      ];
      const isNonsensical = nonsensicalPatterns.some((p) =>
        horizonValue.includes(p)
      );

      if (isNonsensical && daysBetween !== null && daysBetween < 90) {
        toReset.push({
          id: pred.id,
          video_id: pred.video_id,
          asset: pred.asset,
          horizon_value: pred.horizon_value,
          post_date: pred.post_date,
          resolved_at: pred.resolved_at,
          status: pred.status,
          target_price: pred.target_price,
          actual_price: pred.actual_price,
          sentiment: pred.sentiment,
          reason: `Nonsensical horizon closed in ${daysBetween} days`,
        });
      }
    }

    return {
      totalScanned: predictions?.length || 0,
      toReset,
      toDelete,
    };
  }

  /**
   * Reset problematic predictions to pending
   */
  async resetPredictions(recordIds: string[]): Promise<number> {
    if (recordIds.length === 0) return 0;

    logger.info(`Resetting ${recordIds.length} predictions to pending...`);

    const { error } = await supabaseService.supabase
      .from("combined_predictions")
      .update({
        status: "pending",
        actual_price: null,
        resolved_at: null,
        verification_metadata: null,
        ai_reconciliation_agrees: null,
        ai_reconciliation_reasoning: null,
        ai_model_reconciliation: null,
      })
      .in("id", recordIds);

    if (error) {
      logger.error("Failed to reset predictions", { error });
      return 0;
    }

    logger.info(`Successfully reset ${recordIds.length} predictions`);
    return recordIds.length;
  }

  /**
   * Delete predictions and trigger regeneration
   */
  async deletePredictions(records: AuditRecord[]): Promise<number> {
    if (records.length === 0) return 0;

    const ids = records.map((r) => r.id);
    const videoIds = [...new Set(records.map((r) => r.video_id))];

    logger.info(`Deleting ${ids.length} predictions...`);

    const { error: deleteError } = await supabaseService.supabase
      .from("combined_predictions")
      .delete()
      .in("id", ids);

    if (deleteError) {
      logger.error("Failed to delete predictions", { error: deleteError });
      return 0;
    }

    // Reset parent records to trigger regeneration
    const { error: parentError } = await supabaseService.supabase
      .from("finfluencer_predictions")
      .update({ combined_processed_at: null })
      .in("video_id", videoIds);

    if (parentError) {
      logger.warn("Failed to reset parent records", { error: parentError });
    }

    logger.info(
      `Deleted ${ids.length} predictions, reset ${videoIds.length} videos`
    );
    return ids.length;
  }

  /**
   * Run full audit with optional apply
   */
  async runAudit(
    options: { apply?: boolean; limit?: number } = {}
  ): Promise<void> {
    const apply = options.apply ?? false;
    const limit = options.limit ?? 2000;

    logger.info(
      `=== PREDICTION AUDIT ${apply ? "(APPLYING)" : "(DRY RUN)"} ===`
    );

    const result = await this.scanPredictions(limit);

    logger.info(`\n=== AUDIT RESULTS ===`);
    logger.info(`Scanned: ${result.totalScanned}`);
    logger.info(`To Reset: ${result.toReset.length}`);
    logger.info(`To Delete: ${result.toDelete.length}`);

    if (result.toReset.length > 0) {
      logger.info(`\n--- Sample Records to Reset ---`);
      for (const rec of result.toReset.slice(0, 10)) {
        logger.info(`[${rec.asset}] ${rec.horizon_value} | ${rec.reason}`);
      }
    }

    if (apply) {
      await this.resetPredictions(result.toReset.map((r) => r.id));
      await this.deletePredictions(result.toDelete);
    } else {
      logger.info(
        `\nDry run - no changes made. Use apply: true to make changes.`
      );
    }

    logger.info(`\n=== AUDIT COMPLETE ===`);
  }
}

export const predictionAuditService = new PredictionAuditService();
