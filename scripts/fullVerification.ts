import { supabaseService } from "../src/supabase";
import { priceService } from "../src/services/priceService";
import { globalAIAnalyzer } from "../src/enhancedAnalyzer";
import { logger } from "../src/utils";

/**
 * Full Verification Script
 *
 * Re-verifies ALL combined predictions (pending, correct, wrong) using the latest
 * verification logic. Run this monthly/biweekly to audit and fix any issues.
 *
 * Features:
 * - Recalculates horizon dates to fix bad values
 * - Sanitizes insane horizon dates (e.g., year 4051 → capped at 2 years)
 * - Re-runs verification for all horizon-passed predictions
 * - Optional AI verification for ambiguous cases
 * - Shows detailed audit report
 * - Supports dry-run mode
 *
 * Usage:
    # Step 1: Preview cleanup (see duplicates + ridiculous)
    npx ts-node scripts/fullVerification.ts --cleanup
    # Step 2: Apply cleanup (delete bad records)
    npx ts-node scripts/fullVerification.ts --cleanup --apply
    # Step 3: Preview verification (see what would change)
    npx ts-node scripts/fullVerification.ts
    # Step 4: Apply verification (update statuses + fix horizons)
    npx ts-node scripts/fullVerification.ts --apply

    # If that works, process in batches of 1000 with offset
    npx ts-node scripts/fullVerification.ts --limit=1000 --offset=0
    npx ts-node scripts/fullVerification.ts --limit=1000 --offset=1000
    npx ts-node scripts/fullVerification.ts --limit=1000 --offset=2000
    # ... etc

    npx ts-node scripts/fullVerification.ts --verify --use-ai
 */

// Maximum allowed horizon: 15 years from post_date (for predictions like "by 2030")
const MAX_HORIZON_DAYS = 5475; // ~15 years

interface VerificationResult {
  id: string;
  asset: string;
  video_id: string;
  oldStatus: string;
  newStatus: string;
  oldHorizonStart: string | null;
  oldHorizonEnd: string | null;
  newHorizonStart: string;
  newHorizonEnd: string;
  horizonValue: string;
  horizonRecalculated: boolean;
  horizonWasInsane: boolean;
  statusChanged: boolean;
  reason: string;
  targetPrice: number | null;
  entryPrice: number | null;
  actualPrice: number | null;
  aiVerified: boolean;
  aiAgrees: boolean | null;
}

interface InsaneHorizon {
  id: string;
  asset: string;
  horizonValue: string;
  oldEnd: string | null;
  calculatedEnd: string;
  cappedEnd: string;
}

interface VerificationStats {
  total: number;
  processed: number;
  skippedFuture: number;
  statusChanges: {
    correctToWrong: number;
    wrongToCorrect: number;
    pendingToCorrect: number;
    pendingToWrong: number;
    unchanged: number;
  };
  horizonFixes: number;
  insaneHorizons: number;
  aiVerifications: number;
  errors: number;
}

class FullVerificationService {
  private stats: VerificationStats = {
    total: 0,
    processed: 0,
    skippedFuture: 0,
    statusChanges: {
      correctToWrong: 0,
      wrongToCorrect: 0,
      pendingToCorrect: 0,
      pendingToWrong: 0,
      unchanged: 0,
    },
    horizonFixes: 0,
    insaneHorizons: 0,
    aiVerifications: 0,
    errors: 0,
  };

  private results: VerificationResult[] = [];
  private insaneHorizons: InsaneHorizon[] = [];
  private duplicates: { id: string; video_id: string; asset: string }[] = [];
  private ridiculous: { id: string; asset: string; reason: string }[] = [];

  /**
   * Run cleanup to find and remove duplicates + ridiculous records
   */
  async runCleanup(options: { dryRun?: boolean } = {}): Promise<void> {
    const dryRun = options.dryRun ?? true;

    console.log("\n" + "=".repeat(60));
    console.log(`CLEANUP ${dryRun ? "(DRY RUN)" : "(APPLYING)"}`);
    console.log("=".repeat(60));

    // 1. Find duplicates (same video_id + asset)
    console.log("\n🔍 Finding duplicates (same video + asset)...");
    const { data: allPredictions } = await supabaseService.supabase
      .from("combined_predictions")
      .select(
        "id, video_id, asset, post_date, status, sentiment, horizon_value, prediction_text"
      )
      .order("post_date", { ascending: true });

    const seen = new Map<string, any>();
    const duplicatesToDelete: string[] = [];

    for (const pred of allPredictions || []) {
      const key = `${pred.video_id}__${pred.asset?.toLowerCase()}`;
      if (seen.has(key)) {
        // Keep the first one, mark this as duplicate
        this.duplicates.push({
          id: pred.id,
          video_id: pred.video_id,
          asset: pred.asset,
        });
        duplicatesToDelete.push(pred.id);
      } else {
        seen.set(key, pred);
      }
    }

    console.log(`  Found ${this.duplicates.length} duplicates`);

    // 2. Find ridiculous records
    console.log("\n🔍 Finding ridiculous records...");
    for (const pred of allPredictions || []) {
      let isRidiculous = false;
      let reason = "";

      // No asset
      if (!pred.asset || pred.asset.trim() === "") {
        isRidiculous = true;
        reason = "Missing asset";
      }
      // No sentiment
      else if (!pred.sentiment || pred.sentiment === "neutral") {
        // Neutral sentiment with no target is not useful
        isRidiculous = true;
        reason = "Neutral/missing sentiment";
      }
      // Very short prediction text (likely garbage)
      else if (!pred.prediction_text || pred.prediction_text.length < 10) {
        isRidiculous = true;
        reason = "Empty/short prediction text";
      }
      // Asset name too long (likely garbage)
      else if (pred.asset.length > 50) {
        isRidiculous = true;
        reason = "Asset name too long";
      }

      if (isRidiculous && !duplicatesToDelete.includes(pred.id)) {
        this.ridiculous.push({ id: pred.id, asset: pred.asset, reason });
      }
    }

    console.log(`  Found ${this.ridiculous.length} ridiculous records`);

    // 3. Apply cleanup
    if (!dryRun) {
      if (duplicatesToDelete.length > 0) {
        console.log(
          `\n🗑️  Deleting ${duplicatesToDelete.length} duplicates...`
        );
        const { error } = await supabaseService.supabase
          .from("combined_predictions")
          .delete()
          .in("id", duplicatesToDelete);
        if (error) console.error("  Error deleting duplicates:", error);
        else console.log("  ✅ Duplicates deleted");
      }

      if (this.ridiculous.length > 0) {
        const ridiculousIds = this.ridiculous.map((r) => r.id);
        console.log(
          `\n🗑️  Deleting ${ridiculousIds.length} ridiculous records...`
        );
        const { error } = await supabaseService.supabase
          .from("combined_predictions")
          .delete()
          .in("id", ridiculousIds);
        if (error) console.error("  Error deleting ridiculous:", error);
        else console.log("  ✅ Ridiculous records deleted");
      }
    }

    // Print report
    console.log("\n" + "=".repeat(60));
    console.log("CLEANUP REPORT");
    console.log("=".repeat(60));
    console.log(`Duplicates: ${this.duplicates.length}`);
    console.log(`Ridiculous: ${this.ridiculous.length}`);

    if (this.duplicates.length > 0) {
      console.log("\n--- DUPLICATES (first 10) ---");
      for (const d of this.duplicates.slice(0, 10)) {
        console.log(`  [${d.asset}] video: ${d.video_id}`);
      }
      if (this.duplicates.length > 10)
        console.log(`  ... +${this.duplicates.length - 10} more`);
    }

    if (this.ridiculous.length > 0) {
      console.log("\n--- RIDICULOUS (first 10) ---");
      for (const r of this.ridiculous.slice(0, 10)) {
        console.log(`  [${r.asset || "N/A"}] ${r.reason}`);
      }
      if (this.ridiculous.length > 10)
        console.log(`  ... +${this.ridiculous.length - 10} more`);
    }

    console.log("\n" + "=".repeat(60));
    console.log(dryRun ? "DRY RUN - Use --apply to delete" : "CLEANUP APPLIED");
    console.log("=".repeat(60));
  }

  async verifyAll(
    options: {
      limit?: number;
      dryRun?: boolean;
      offset?: number;
      useAI?: boolean;
    } = {}
  ): Promise<void> {
    const limit = options.limit ?? 10000;
    const dryRun = options.dryRun ?? true;
    const offset = options.offset ?? 0;
    const useAI = options.useAI ?? false;
    const now = new Date();

    logger.info("=".repeat(60));
    logger.info(
      `FULL VERIFICATION ${dryRun ? "(DRY RUN)" : "(APPLYING CHANGES)"}`
    );
    logger.info("=".repeat(60));
    logger.info(`Limit: ${limit}, Offset: ${offset}, AI: ${useAI}`);
    logger.info(`Current time: ${now.toISOString()}`);

    const { data: predictions, error } = await supabaseService.supabase
      .from("combined_predictions")
      .select(
        "id, video_id, asset, asset_type, post_date, horizon_value, horizon_type, " +
          "horizon_start_date, horizon_end_date, asset_entry_price, target_price, " +
          "sentiment, status, actual_price, resolved_at, prediction_text"
      )
      .order("post_date", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error("Failed to fetch predictions", { error });
      return;
    }

    this.stats.total = predictions?.length || 0;
    logger.info(`Fetched ${this.stats.total} predictions for verification`);

    let processed = 0;
    const startTime = Date.now();
    for (const pred of predictions || []) {
      try {
        const predStart = Date.now();
        await this.verifyPrediction(pred, now, dryRun, useAI);
        processed++;
        const predTime = Date.now() - predStart;

        // Log every prediction with timing
        logger.info(
          `[${processed}/${this.stats.total}] ${
            (pred as any).asset
          } - ${predTime}ms`
        );

        // Log summary every 10 predictions
        if (processed % 10 === 0) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const avgTime = Math.round((Date.now() - startTime) / processed);
          const remaining = Math.round(
            (avgTime * (this.stats.total - processed)) / 1000
          );
          logger.info(
            `Progress: ${processed}/${this.stats.total} | Elapsed: ${elapsed}s | ETA: ${remaining}s`
          );
        }
      } catch (err) {
        this.stats.errors++;
        logger.error(`Error verifying prediction ${(pred as any).id}`, { err });
      }
    }

    this.printReport(dryRun);
  }

  private async verifyPrediction(
    pred: any,
    now: Date,
    dryRun: boolean,
    useAI: boolean
  ): Promise<void> {
    const postDate = new Date(pred.post_date);
    const horizonValue = pred.horizon_value || "1 month";
    const horizonType = pred.horizon_type || "custom";

    // Recalculate horizon dates
    // Recalculate horizon dates
    let newHorizonStart: Date;
    let newHorizonEnd: Date;

    if (useAI) {
      const hResult = await priceService.calculateHorizonDateRangeWithAI(
        postDate,
        horizonValue,
        horizonType
      );
      newHorizonStart = hResult.start;
      newHorizonEnd = hResult.end;
    } else {
      const hResult = priceService.calculateHorizonDateRange(
        postDate,
        horizonValue,
        horizonType
      );
      newHorizonStart = hResult.start;
      newHorizonEnd = hResult.end;
    }

    // SANITIZE: Cap insane horizon dates at 2 years
    const maxAllowedEnd = new Date(postDate);
    maxAllowedEnd.setDate(maxAllowedEnd.getDate() + MAX_HORIZON_DAYS);

    let horizonWasInsane = false;
    if (newHorizonEnd > maxAllowedEnd) {
      horizonWasInsane = true;
      this.stats.insaneHorizons++;
      this.insaneHorizons.push({
        id: pred.id,
        asset: pred.asset,
        horizonValue: pred.horizon_value,
        oldEnd: pred.horizon_end_date,
        calculatedEnd: newHorizonEnd.toISOString(),
        cappedEnd: maxAllowedEnd.toISOString(),
      });
      newHorizonEnd = maxAllowedEnd;
    }

    if (newHorizonStart > maxAllowedEnd) {
      newHorizonStart = new Date(postDate);
      newHorizonStart.setDate(newHorizonStart.getDate() + 7);
    }

    const oldHorizonStart = pred.horizon_start_date
      ? new Date(pred.horizon_start_date)
      : null;
    const oldHorizonEnd = pred.horizon_end_date
      ? new Date(pred.horizon_end_date)
      : null;

    const horizonRecalculated =
      horizonWasInsane ||
      !oldHorizonStart ||
      !oldHorizonEnd ||
      Math.abs(newHorizonStart.getTime() - (oldHorizonStart?.getTime() || 0)) >
        7 * 24 * 60 * 60 * 1000 ||
      Math.abs(newHorizonEnd.getTime() - (oldHorizonEnd?.getTime() || 0)) >
        7 * 24 * 60 * 60 * 1000;

    if (horizonRecalculated) {
      this.stats.horizonFixes++;
    }

    if (now < newHorizonStart) {
      this.stats.skippedFuture++;
      return;
    }

    // Parse prices
    let entryPrice: number | null = null;
    let targetPrice: number | null = null;

    if (pred.asset_entry_price) {
      entryPrice = parseFloat(String(pred.asset_entry_price));
      if (isNaN(entryPrice)) entryPrice = null;
    }

    if (pred.target_price) {
      targetPrice = parseFloat(String(pred.target_price));
      if (isNaN(targetPrice)) targetPrice = null;
    }

    // Fetch entry price if missing
    if (entryPrice === null && !dryRun) {
      const price = await priceService.searchPrice(
        pred.asset,
        postDate,
        pred.asset_type
      );
      if (price !== null) {
        entryPrice = price;
        await supabaseService.supabase
          .from("combined_predictions")
          .update({
            asset_entry_price: String(price),
            updated_at: new Date().toISOString(),
          })
          .eq("id", pred.id);
      }
    }

    // Run verification
    const verificationResult = await priceService.verifyPredictionWithRange(
      pred.asset,
      entryPrice,
      targetPrice,
      pred.sentiment || "neutral",
      newHorizonStart,
      newHorizonEnd,
      pred.asset_type
    );

    const oldStatus = pred.status;
    let newStatus = verificationResult.status;
    let aiAgrees: boolean | null = null;
    let aiVerified = false;

    // AI Verification
    if (useAI && newStatus !== "pending" && oldStatus !== newStatus) {
      try {
        this.stats.aiVerifications++;
        aiVerified = true;
        const aiResult = await this.runAIVerification(
          pred,
          entryPrice,
          targetPrice,
          verificationResult.actualPrice || null,
          newStatus
        );
        aiAgrees = aiResult.agrees;
        if (!aiResult.agrees && aiResult.suggestedStatus) {
          newStatus = aiResult.suggestedStatus;
        }
      } catch (err) {
        logger.warn(`AI verification failed for ${pred.id}`, { err });
      }
    }

    const statusChanged = oldStatus !== newStatus;

    // Track status changes
    if (statusChanged) {
      if (oldStatus === "correct" && newStatus === "wrong")
        this.stats.statusChanges.correctToWrong++;
      else if (oldStatus === "wrong" && newStatus === "correct")
        this.stats.statusChanges.wrongToCorrect++;
      else if (oldStatus === "pending" && newStatus === "correct")
        this.stats.statusChanges.pendingToCorrect++;
      else if (oldStatus === "pending" && newStatus === "wrong")
        this.stats.statusChanges.pendingToWrong++;
    } else {
      this.stats.statusChanges.unchanged++;
    }

    this.stats.processed++;

    // Build reason
    let reason = "";
    if (horizonWasInsane)
      reason += `INSANE HORIZON CAPPED (was: ${pred.horizon_end_date?.slice(
        0,
        10
      )}). `;
    else if (horizonRecalculated) reason += `Horizon fixed. `;
    if (statusChanged) reason += `${oldStatus} → ${newStatus}. `;
    if (aiVerified) reason += `AI ${aiAgrees ? "agrees" : "disagrees"}. `;

    if (statusChanged || horizonRecalculated) {
      this.results.push({
        id: pred.id,
        asset: pred.asset,
        video_id: pred.video_id,
        oldStatus,
        newStatus,
        oldHorizonStart: oldHorizonStart?.toISOString()?.slice(0, 10) || null,
        oldHorizonEnd: oldHorizonEnd?.toISOString()?.slice(0, 10) || null,
        newHorizonStart: newHorizonStart.toISOString().slice(0, 10),
        newHorizonEnd: newHorizonEnd.toISOString().slice(0, 10),
        horizonValue: pred.horizon_value,
        horizonRecalculated,
        horizonWasInsane,
        statusChanged,
        reason: reason.trim(),
        targetPrice,
        entryPrice,
        actualPrice: verificationResult.actualPrice || null,
        aiVerified,
        aiAgrees,
      });
    }

    // Apply changes
    if (!dryRun && (statusChanged || horizonRecalculated)) {
      const updateData: any = {
        horizon_start_date: newHorizonStart.toISOString(),
        horizon_end_date: newHorizonEnd.toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (statusChanged && newStatus !== "pending") {
        updateData.status = newStatus;
        updateData.resolved_at = new Date().toISOString();
        if (verificationResult.actualPrice) {
          updateData.actual_price = String(verificationResult.actualPrice);
        }
      }

      await supabaseService.supabase
        .from("combined_predictions")
        .update(updateData)
        .eq("id", pred.id);
    }
  }

  private async runAIVerification(
    pred: any,
    entryPrice: number | null,
    targetPrice: number | null,
    actualPrice: number | null,
    proposedStatus: string
  ): Promise<{ agrees: boolean; suggestedStatus?: "correct" | "wrong" }> {
    const prompt = `Verify this financial prediction outcome:

Asset: ${pred.asset} (${pred.asset_type})
Sentiment: ${pred.sentiment}
Prediction: "${pred.prediction_text?.slice(0, 200) || "N/A"}"
Entry Price: ${entryPrice || "Unknown"}
Target Price: ${targetPrice || "None specified"}
Actual Price at horizon end: ${actualPrice || "Unknown"}
Proposed Status: ${proposedStatus}

Based on the sentiment and any target price, should this be "${proposedStatus}"?
Reply with JSON only: {"agrees": true, "reason": "brief"} or {"agrees": false, "reason": "brief", "suggestedStatus": "correct"} or {"agrees": false, "reason": "brief", "suggestedStatus": "wrong"}`;

    try {
      // Use the sendRequest method from globalAIAnalyzer
      const response = await (globalAIAnalyzer as any).sendRequest(prompt);
      const content = response?.choices?.[0]?.message?.content || "";

      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { agrees: true };

      const parsed = JSON.parse(jsonMatch[0]);
      const suggestedStatus = parsed.suggestedStatus;

      return {
        agrees: parsed.agrees === true,
        suggestedStatus:
          suggestedStatus === "correct" || suggestedStatus === "wrong"
            ? suggestedStatus
            : undefined,
      };
    } catch {
      return { agrees: true };
    }
  }

  private printReport(dryRun: boolean): void {
    console.log("\n" + "=".repeat(70));
    console.log("VERIFICATION REPORT");
    console.log("=".repeat(70));
    console.log(`Mode: ${dryRun ? "DRY RUN (no changes made)" : "APPLIED"}`);
    console.log(
      `Total: ${this.stats.total} | Processed: ${this.stats.processed} | Skipped: ${this.stats.skippedFuture} | Errors: ${this.stats.errors}`
    );

    console.log("\n--- STATUS CHANGES ---");
    console.log(
      `  Correct → Wrong: ${this.stats.statusChanges.correctToWrong}`
    );
    console.log(
      `  Wrong → Correct: ${this.stats.statusChanges.wrongToCorrect}`
    );
    console.log(
      `  Pending → Correct: ${this.stats.statusChanges.pendingToCorrect}`
    );
    console.log(
      `  Pending → Wrong: ${this.stats.statusChanges.pendingToWrong}`
    );
    console.log(`  Unchanged: ${this.stats.statusChanges.unchanged}`);

    console.log("\n--- HORIZON FIXES ---");
    console.log(`  Total Fixed: ${this.stats.horizonFixes}`);
    console.log(`  🚨 INSANE (capped): ${this.stats.insaneHorizons}`);

    if (this.stats.aiVerifications > 0) {
      console.log(`\n--- AI: ${this.stats.aiVerifications} verifications ---`);
    }

    if (this.insaneHorizons.length > 0) {
      console.log("\n--- 🚨 INSANE HORIZONS (first 15) ---");
      for (const h of this.insaneHorizons.slice(0, 15)) {
        console.log(
          `  [${h.asset}] "${h.horizonValue}" → Was: ${
            h.oldEnd?.slice(0, 10) || "NULL"
          }, Capped: ${h.cappedEnd.slice(0, 10)}`
        );
      }
      if (this.insaneHorizons.length > 15)
        console.log(`  ... +${this.insaneHorizons.length - 15} more`);
    }

    if (this.results.length > 0) {
      console.log("\n--- CHANGES (first 15) ---");
      for (const r of this.results.slice(0, 15)) {
        console.log(`  [${r.asset}] ${r.reason}`);
      }
      if (this.results.length > 15)
        console.log(`  ... +${this.results.length - 15} more`);
    }

    console.log("\n" + "=".repeat(70));
    console.log(
      dryRun ? "DRY RUN - Run with --apply to make changes" : "CHANGES APPLIED"
    );
    console.log("=".repeat(70));
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--apply");
  const useAI = args.includes("--use-ai");
  const cleanup = args.includes("--cleanup");
  const limitArg = args.find((a) => a.startsWith("--limit"));
  const limit = limitArg ? parseInt(limitArg.split("=")[1] || "10000") : 10000;
  const offsetArg = args.find((a) => a.startsWith("--offset"));
  const offset = offsetArg ? parseInt(offsetArg.split("=")[1] || "0") : 0;

  console.log(`\n🔍 Full Verification Script`);
  console.log(`   Mode: ${cleanup ? "CLEANUP" : "VERIFY"}`);
  console.log(
    `   --apply: ${!dryRun}, --use-ai: ${useAI}, --limit: ${limit}, --offset: ${offset}\n`
  );

  const service = new FullVerificationService();

  if (cleanup) {
    // Run cleanup mode: find and remove duplicates + ridiculous records
    await service.runCleanup({ dryRun });
  } else {
    // Run verification mode
    await service.verifyAll({ limit, dryRun, offset, useAI });
  }
}

if (require.main === module) {
  main()
    .then(() => {
      console.log("\n✅ Completed");
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n❌ Failed:", err);
      process.exit(1);
    });
}

export { FullVerificationService };
