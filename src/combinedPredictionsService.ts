import axios from "axios";
import { config } from "./config";
import { logger } from "./utils";
import { supabaseService } from "./supabase";
import { priceService } from "./services/priceService";
import { reportingService } from "./services/reportingService";
import { globalAIAnalyzer } from "./enhancedAnalyzer";

/**
 * Combined Predictions Service
 * Processes analyzed predictions, fetches historical prices via Google Search, and stores combined predictions
 */
export class CombinedPredictionsService {
  private readonly DEFAULT_CONCURRENCY = 3;
  private readonly DEFAULT_RETRY_COUNT = 3;

  /**
   * Log structured logs similar to edge function
   */
  private log(
    level: string,
    message: string,
    meta: Record<string, any> = {}
  ): void {
    logger[level as keyof typeof logger](message, meta);
  }

  /**
   * Format error messages safely
   */
  private safeErrorMessage(err: any): string {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    if (typeof err === "object") return err.message ?? JSON.stringify(err);
    return String(err);
  }

  /**
   * Format date for API calls
   */
  private formatDateForApi(dateStr: string): string {
    try {
      return new Date(dateStr).toISOString().split("T")[0];
    } catch {
      return dateStr;
    }
  }

  /**
   * Normalize prediction text for deduplication
   */
  private normalizePredictionText(text: any): string {
    if (!text) return "";
    if (typeof text !== "string") text = JSON.stringify(text);
    return text.trim().replace(/\s+/g, " ").toLowerCase();
  }

  /**
   * Create normalized key for duplicate detection
   */
  private createNormalizedKey(
    videoId: string,
    asset: string,
    text: string
  ): string {
    return `${videoId}::${(asset || "")
      .toUpperCase()
      .trim()}::${this.normalizePredictionText(text)}`;
  }

  /**
   * Insert telemetry record for tracking
   */
  private async insertTelemetry(entry: {
    function: string;
    event: string;
    processed?: number;
    inserted?: number;
    skipped?: number;
    errors?: number;
    prices_fetched?: number;
    runtime_ms?: number;
    request_id?: string;
    details?: Record<string, any>;
  }): Promise<void> {
    try {
      const { error } = await supabaseService.supabase
        .from("function_logs")
        .insert({
          function: entry.function,
          event: entry.event,
          processed: entry.processed ?? null,
          inserted: entry.inserted ?? null,
          skipped: entry.skipped ?? null,
          errors: entry.errors ?? null,
          prices_fetched: entry.prices_fetched ?? null,
          runtime_ms: entry.runtime_ms ?? null,
          request_id: entry.request_id ?? null,
          details: entry.details ?? {},
          created_at: new Date().toISOString(),
        });

      if (error) {
        this.log("warn", "Telemetry insert failed", {
          err: this.safeErrorMessage(error),
        });
      }
    } catch (err) {
      this.log("warn", "Telemetry insert unexpected error", {
        err: this.safeErrorMessage(err),
      });
    }
  }

  /**
   * Main processing function
   * Combines analyzed predictions, fetches prices, and stores in combined_predictions table
   */
  async processPredictions(
    options: {
      limit?: number;
      skipPrice?: boolean;
      dryRun?: boolean;
      concurrency?: number;
      retryCount?: number;
      requestId?: string;
    } = {}
  ): Promise<{
    request_id: string;
    processed_records: number;
    inserted: number;
    skipped: number;
    errors: number;
    prices_fetched: number;
  }> {
    const requestId =
      options.requestId || crypto.randomUUID?.() || String(Date.now());
    const start = Date.now();

    const limit = Math.max(1, Math.min(2000, options.limit || 500));
    const skipPrice = options.skipPrice ?? false;
    const dryRun = options.dryRun ?? false;
    const concurrency = options.concurrency || this.DEFAULT_CONCURRENCY;
    const retryCount = options.retryCount || this.DEFAULT_RETRY_COUNT;

    this.log("info", "Combined predictions processing started", {
      requestId,
      limit,
      skipPrice,
      dryRun,
      concurrency,
      retryCount,
    });

    if (!dryRun) {
      // Log start - using new reportingService instead of function_logs telemetry
      // insertTelemetry removed as function_logs table is being deprecated
    }

    return this.executeProcessing(
      requestId,
      limit,
      skipPrice,
      dryRun,
      concurrency,
      retryCount,
      start
    );
  }

  /**
   * Reconcile combined_predictions where the horizon date has passed.
   * Updates `status` to 'correct' or 'wrong' based on actual price vs target.
   */
  async reconcilePredictions(
    options: {
      limit?: number;
      dryRun?: boolean;
      retryCount?: number;
      useAI?: boolean;
      requestId?: string;
    } = {}
  ): Promise<void> {
    const requestId =
      options.requestId || crypto.randomUUID?.() || String(Date.now());
    const limit = options.limit ?? 500;
    const dryRun = options.dryRun ?? false;

    this.log("info", "Reconciling horizon-passed combined predictions", {
      requestId,
      limit,
      dryRun,
    });

    try {
      // Fetch pending predictions
      const { data: rows, error } = await supabaseService.supabase
        .from("combined_predictions")
        .select(
          "id, asset, asset_type, post_date, horizon_value, horizon_type, horizon_start_date, horizon_end_date, asset_entry_price, target_price, sentiment, status"
        )
        .eq("status", "pending")
        .limit(limit);

      if (error) return;

      const now = new Date();

      for (const row of rows || []) {
        try {
          const symbol = row.asset || "UNKNOWN";
          const postDate = new Date(row.post_date);
          // Calculate horizon date range
          const horizonValue = row.horizon_value || "1 month";
          const horizonType = row.horizon_type || "custom";
          const { start: horizonStart, end: horizonEnd } =
            priceService.calculateHorizonDateRange(
              postDate,
              horizonValue,
              horizonType
            );

          // If horizon start hasn't passed yet, skip
          if (now < horizonStart) {
            continue;
          }

          this.log("info", `Checking horizon price for ${symbol}`, {
            horizonStart: horizonStart.toISOString(),
            horizonEnd: horizonEnd.toISOString(),
            rowId: row.id,
          });

          let targetPriceNum: number | null = null;
          if (row.target_price) {
            targetPriceNum = parseFloat(String(row.target_price));
            if (isNaN(targetPriceNum)) targetPriceNum = null;
          }

          let entryPriceNum: number | null = null;
          if (row.asset_entry_price) {
            entryPriceNum = parseFloat(String(row.asset_entry_price));
            if (isNaN(entryPriceNum)) entryPriceNum = null;
          }

          // If entry price is missing, try to fetch it now for the post_date
          if (entryPriceNum === null && !dryRun) {
            const price = await priceService.searchPrice(
              symbol,
              postDate,
              row.asset_type
            );
            if (price !== null) {
              entryPriceNum = price;

              // Update the database immediately so we don't lose this found price
              await supabaseService.supabase
                .from("combined_predictions")
                .update({
                  asset_entry_price: String(price),
                  updated_at: new Date().toISOString(),
                })
                .eq("id", row.id);

              this.log(
                "info",
                `Found and updated missing entry price for ${symbol}`,
                {
                  id: row.id,
                  price: price,
                }
              );
            }
          }

          // Verify prediction with range
          const verificationResult =
            await priceService.verifyPredictionWithRange(
              symbol,
              entryPriceNum,
              targetPriceNum,
              row.sentiment || "neutral",
              horizonStart,
              horizonEnd,
              row.asset_type
            );

          if (verificationResult.status !== "pending" && !dryRun) {
            let finalStatus = verificationResult.status;
            let aiReconciliationAgrees: boolean | null = null;
            let aiReconciliationReasoning: string | null = null;
            let aiModelReconciliation: string | null = null;

            // AI Verification (if enabled)
            if (
              options.useAI &&
              (verificationResult.status === "correct" ||
                verificationResult.status === "wrong")
            ) {
              try {
                this.log("info", `🤖 Running AI verification for ${symbol}`, {
                  rowId: row.id,
                });

                const aiResult =
                  await globalAIAnalyzer.verifyReconciliationDecision({
                    asset: symbol,
                    assetType: row.asset_type || "unknown",
                    sentiment: row.sentiment || "neutral",
                    targetPrice: targetPriceNum,
                    entryPrice: entryPriceNum,
                    actualPrice: verificationResult.actualPrice,
                    postDate: row.post_date,
                    horizonStart: horizonStart.toISOString().split("T")[0],
                    horizonEnd: horizonEnd.toISOString().split("T")[0],
                    horizonValue: horizonValue,
                    ruleBasedDecision: verificationResult.status as
                      | "correct"
                      | "wrong",
                    ruleBasedReasoning: `Entry: ${entryPriceNum}, Actual: ${verificationResult.actualPrice}, Target: ${targetPriceNum}, Sentiment: ${row.sentiment}`,
                  });

                aiReconciliationAgrees = aiResult.agrees;
                aiReconciliationReasoning = aiResult.reasoning;
                aiModelReconciliation = aiResult.model;

                // If AI disagrees with high confidence, use AI's decision
                if (!aiResult.agrees && aiResult.confidence === "high") {
                  this.log(
                    "warn",
                    `⚠️ AI disagrees with rule-based decision for ${symbol}`,
                    {
                      rowId: row.id,
                      ruleBasedDecision: verificationResult.status,
                      aiDecision: aiResult.finalDecision,
                      aiReasoning: aiResult.reasoning,
                    }
                  );

                  if (aiResult.finalDecision !== "inconclusive") {
                    finalStatus = aiResult.finalDecision;
                  }
                } else {
                  this.log(
                    "info",
                    `✅ AI ${
                      aiResult.agrees ? "agrees" : "disagrees (low confidence)"
                    } with decision for ${symbol}`,
                    {
                      confidence: aiResult.confidence,
                    }
                  );
                }
              } catch (aiError) {
                this.log(
                  "warn",
                  `AI verification failed for ${symbol}, using rule-based decision`,
                  {
                    error: this.safeErrorMessage(aiError),
                  }
                );
              }
            }

            await supabaseService.supabase
              .from("combined_predictions")
              .update({
                status: finalStatus,
                actual_price: verificationResult.actualPrice,
                resolved_at: new Date().toISOString(),
                verification_metadata: verificationResult.metDate
                  ? { met_on_date: verificationResult.metDate.toISOString() }
                  : {},
                ...(aiModelReconciliation && {
                  ai_model_reconciliation: aiModelReconciliation,
                }),
                ...(aiReconciliationAgrees !== null && {
                  ai_reconciliation_agrees: aiReconciliationAgrees,
                }),
                ...(aiReconciliationReasoning && {
                  ai_reconciliation_reasoning: aiReconciliationReasoning,
                }),
              })
              .eq("id", row.id);

            this.log(
              "info",
              `Resolved prediction ${row.id} as ${finalStatus}${
                options.useAI
                  ? ` (AI ${aiReconciliationAgrees ? "agreed" : "overrode"})`
                  : ""
              }`,
              {
                symbol,
                actualPrice: verificationResult.actualPrice,
                metDate: verificationResult.metDate,
                aiUsed: !!options.useAI,
              }
            );
          }
        } catch (e) {
          this.log("error", "Error reconciling record", {
            err: this.safeErrorMessage(e),
            row,
          });
        }
      }
    } catch (err) {
      this.log("error", "Unhandled error during reconciliation", {
        err: this.safeErrorMessage(err),
      });
    }
  }

  /**
   * Execute the actual processing
   */
  private async executeProcessing(
    requestId: string,
    limit: number,
    skipPrice: boolean,
    dryRun: boolean,
    concurrency: number,
    retryCount: number,
    start: number
  ): Promise<{
    request_id: string;
    processed_records: number;
    inserted: number;
    skipped: number;
    errors: number;
    prices_fetched: number;
  }> {
    let inserted = 0;
    let skipped = 0;
    let errorsCount = 0;
    let pricesFetched = 0;
    let processedRecords = 0;

    try {
      // Fetch unprocessed predictions for combining
      const { data: records, error } = await supabaseService.supabase
        .from("finfluencer_predictions")
        .select("*")
        .eq("subject_outcome", "analyzed")
        .is("combined_processed_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        throw new Error(
          `Failed to fetch predictions: ${this.safeErrorMessage(error)}`
        );
      }

      // If no analyzed records found, try pending records with non-empty predictions
      let finalRecords = records || [];
      if (finalRecords.length === 0) {
        this.log(
          "info",
          "No unprocessed analyzed records, checking pending records with predictions",
          { requestId }
        );

        const { data: pendingWithPred, error: pendingErr } =
          await supabaseService.supabase
            .from("finfluencer_predictions")
            .select("*")
            .eq("subject_outcome", "pending")
            .is("combined_processed_at", null)
            .order("created_at", { ascending: false })
            .limit(limit);

        if (!pendingErr && pendingWithPred) {
          finalRecords = pendingWithPred.filter((rec) => {
            try {
              const arr = Array.isArray(rec.predictions)
                ? rec.predictions
                : JSON.parse(rec.predictions || "[]");
              return arr.length > 0;
            } catch {
              return false;
            }
          });
        }
      }

      processedRecords = finalRecords?.length || 0;
      this.log("info", `Processing ${processedRecords} records`, {
        requestId,
        recordsFound: processedRecords,
      });

      // Process each record
      for (const rec of finalRecords || []) {
        try {
          const videoId = rec.video_id;
          const predictions = Array.isArray(rec.predictions)
            ? rec.predictions
            : JSON.parse(rec.predictions || "[]");
          const postDateObj = rec.post_date
            ? new Date(rec.post_date)
            : new Date();

          if (!rec.post_date) {
            this.log(
              "warn",
              "Missing post_date for video, defaulting to today",
              { videoId: rec.video_id }
            );
          }

          if (!Array.isArray(predictions) || predictions.length === 0) {
            // Mark as processed if no predictions
            if (!dryRun) {
              await supabaseService.supabase
                .from("finfluencer_predictions")
                .update({ combined_processed_at: new Date().toISOString() })
                .eq("id", rec.id);
            }
            skipped++;
            continue;
          }

          // Fetch existing combined predictions to detect duplicates
          let existingRows: any[] = [];
          try {
            const { data } = await supabaseService.supabase
              .from("combined_predictions")
              .select("video_id, asset, prediction_text")
              .eq("video_id", videoId);
            existingRows = data || [];
          } catch (e) {
            // ignore
          }

          // Process each prediction directly
          for (const p of predictions) {
            try {
              let asset = p.asset || "UNKNOWN";
              // Normalize asset name immediately
              asset = priceService.normalizeAssetName(asset);

              const predictionText = p.prediction_text || "";
              const normalizedKey = this.createNormalizedKey(
                videoId,
                asset,
                predictionText
              );

              // Check for duplicates
              const isDuplicate = existingRows.some(
                (ex) =>
                  this.createNormalizedKey(
                    ex.video_id,
                    ex.asset,
                    ex.prediction_text
                  ) === normalizedKey
              );

              if (isDuplicate) {
                skipped++;
                continue;
              }

              // Use raw asset as ticker since we removed AI normalization
              const ticker = asset;

              // Infer asset type if missing
              let assetType = p.asset_type;
              if (!assetType) {
                assetType = this.inferAssetType(asset);
              }

              // Detect currency based on symbol and asset type
              const currency = priceService.detectCurrency(ticker, assetType);

              // Fetch historical price if enabled
              let entryPrice = null;
              let formattedEntryPrice = null;

              if (!skipPrice && rec.post_date) {
                const price = await priceService.searchPrice(
                  ticker,
                  postDateObj,
                  assetType
                );
                if (price !== null) {
                  entryPrice = String(price);
                  const symbol = priceService.getCurrencySymbol(currency);
                  // If symbol is different from ISO code (e.g. $ vs USD), use Prefix ($100).
                  // Otherwise use Suffix (100 USD).
                  if (symbol !== currency) {
                    formattedEntryPrice = `${symbol}${Math.round(price)}`;
                  } else {
                    formattedEntryPrice = `${Math.round(price)} ${currency}`;
                  }
                  pricesFetched++;
                }
              }

              // Calculate horizon dates
              const { start: horizonStart, end: horizonEnd } =
                priceService.calculateHorizonDateRange(
                  postDateObj,
                  p.horizon?.value || "1 month",
                  p.horizon?.type || "custom"
                );

              // Create combined row
              const combinedRow = {
                channel_id: rec.channel_id,
                channel_name: rec.channel_name,
                video_id: videoId,
                post_date: postDateObj.toISOString(),
                asset,
                asset_type: assetType, // New field
                asset_entry_price: entryPrice,
                formatted_price: formattedEntryPrice,
                price_currency: currency,
                horizon_value: p.horizon?.value || "",
                horizon_type: p.horizon?.type || "custom", // New field
                horizon_start_date: horizonStart.toISOString(), // New field
                horizon_end_date: horizonEnd.toISOString(), // New field
                sentiment: p.sentiment || "neutral",
                confidence: p.confidence || "medium",
                target_price: p.target_price ? String(p.target_price) : null,
                prediction_text: predictionText,
                status: "pending",
                platform: "YouTube",
              };

              if (!dryRun) {
                const { error: insertError } = await supabaseService.supabase
                  .from("combined_predictions")
                  .insert(combinedRow);

                if (insertError) {
                  this.log("error", "Failed to insert combined prediction", {
                    err: this.safeErrorMessage(insertError),
                  });
                  errorsCount++;
                } else {
                  inserted++;
                }
              } else {
                inserted++;
              }
            } catch (predErr) {
              this.log("error", "Error processing single prediction", {
                err: this.safeErrorMessage(predErr),
                asset: p.asset,
              });
              errorsCount++;
            }
          }

          // Mark parent record as processed
          if (!dryRun) {
            await supabaseService.supabase
              .from("finfluencer_predictions")
              .update({ combined_processed_at: new Date().toISOString() })
              .eq("id", rec.id);
          }
        } catch (err) {
          this.log("error", "Error processing record", {
            err: this.safeErrorMessage(err),
            videoId: rec.video_id,
          });
          errorsCount++;
        }
      }
    } catch (err) {
      this.log("error", "Fatal error in executeProcessing", {
        err: this.safeErrorMessage(err),
      });
      errorsCount++;
    }

    const runtime = Date.now() - start;
    this.log("info", "Combined predictions processing completed", {
      requestId,
      processed: processedRecords,
      inserted,
      skipped,
      errors: errorsCount,
      pricesFetched,
      runtimeMs: runtime,
    });

    if (!dryRun) {
      // Report combined predictions metrics
      reportingService.addCombinedInserted(inserted);
      reportingService.addCombinedSkipped(skipped);
      // insertTelemetry removed as function_logs table is being deprecated
    }

    return {
      request_id: requestId,
      processed_records: processedRecords,
      inserted,
      skipped: skipped,
      errors: errorsCount,
      prices_fetched: pricesFetched,
    };
  }

  /**
   * Infer asset type from asset name
   */
  private inferAssetType(asset: string): string {
    const upper = asset.toUpperCase().trim();

    // Crypto
    if (
      [
        "BTC",
        "ETH",
        "SOL",
        "XRP",
        "ADA",
        "DOGE",
        "DOT",
        "AVAX",
        "MATIC",
        "LINK",
        "UNI",
        "ATOM",
        "LTC",
        "BCH",
      ].includes(upper)
    )
      return "crypto";

    // Commodities
    if (
      [
        "GOLD",
        "SILVER",
        "CRUDE",
        "OIL",
        "NATURAL GAS",
        "BRENT",
        "WTI",
      ].includes(upper)
    )
      return "commodity";

    // Forex
    if (
      ["EURUSD", "USDJPY", "GBPUSD", "USDTRY", "EURTRY", "XAUUSD"].includes(
        upper
      )
    )
      return "fx";

    // Indices
    if (
      [
        "SP500",
        "NASDAQ",
        "DOW",
        "DAX",
        "FTSE",
        "NIKKEI",
        "BIST100",
        "BIST30",
      ].includes(upper)
    )
      return "index";

    // Default to stock
    return "stock";
  }

  /**
   * Retry fetching missing entry prices for predictions
   * @param limit - Maximum number of records to process
   * @param dryRun - If true, will not update the database
   */
  async retryMissingEntryPrices(
    limit: number = 50,
    dryRun: boolean = false
  ): Promise<{
    processed: number;
    updated: number;
    failed: number;
  }> {
    const requestId = Math.random().toString(36).substring(7);
    this.log("info", "Starting entry price retry process", {
      requestId,
      limit,
      dryRun,
    });

    try {
      // Fetch predictions with null asset_entry_price
      const { data: rows, error } = await supabaseService.supabase
        .from("combined_predictions")
        .select("id, asset, asset_type, post_date")
        .is("asset_entry_price", null)
        .limit(limit);

      if (error) {
        this.log("error", "Error fetching predictions with missing prices", {
          error,
        });
        throw error;
      }

      if (!rows || rows.length === 0) {
        this.log("info", "No predictions found with missing entry prices");
        return { processed: 0, updated: 0, failed: 0 };
      }

      let updated = 0;
      let failed = 0;

      for (const row of rows) {
        try {
          const asset = row.asset;
          const postDate = new Date(row.post_date);

          // Infer asset type if missing
          let assetType = row.asset_type;
          if (!assetType) {
            assetType = this.inferAssetType(asset);
          }

          // Fetch price
          const price = await priceService.searchPrice(
            asset,
            postDate,
            assetType
          );

          if (price !== null && !dryRun) {
            // Update the record
            const { error: updateError } = await supabaseService.supabase
              .from("combined_predictions")
              .update({
                asset_entry_price: String(price),
                asset_type: assetType, // Also update asset_type if it was inferred
              })
              .eq("id", row.id);

            if (updateError) {
              this.log("error", "Error updating entry price", {
                id: row.id,
                error: updateError,
              });
              failed++;
            } else {
              this.log("info", `Updated entry price for ${asset}`, {
                id: row.id,
                price,
              });
              updated++;
            }
          } else if (price === null) {
            this.log(
              "warn",
              `Could not fetch price for ${asset} on ${postDate.toISOString()}`,
              { id: row.id }
            );
            failed++;
          } else {
            // Dry run with price found
            this.log(
              "info",
              `[DRY RUN] Would update ${asset} with price ${price}`,
              { id: row.id }
            );
            updated++;
          }

          // Small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (err) {
          this.log("error", "Error processing record", {
            id: row.id,
            error: this.safeErrorMessage(err),
          });
          failed++;
        }
      }

      this.log("info", "Entry price retry process completed", {
        requestId,
        processed: rows.length,
        updated,
        failed,
      });

      return { processed: rows.length, updated, failed };
    } catch (err) {
      this.log("error", "Entry price retry process failed", {
        error: this.safeErrorMessage(err),
      });
      throw err;
    }
  }
}

export const combinedPredictionsService = new CombinedPredictionsService();
