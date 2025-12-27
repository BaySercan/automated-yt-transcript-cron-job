import axios from "axios";
import { config } from "./config";
import { logger } from "./utils";
import { supabaseService } from "./supabase";
import { priceService } from "./services/priceService";
import { reportingService } from "./services/reportingService";
import { assetClassifierService } from "./services/assetClassifierService";
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
      // Fetch pending predictions - order by horizon_end_date to process oldest first
      const { data: rows, error } = await supabaseService.supabase
        .from("combined_predictions")
        .select(
          "id, asset, asset_type, post_date, horizon_value, horizon_type, horizon_start_date, horizon_end_date, asset_entry_price, target_price, sentiment, status"
        )
        .eq("status", "pending")
        .order("horizon_end_date", { ascending: true }) // Process oldest predictions first
        .limit(limit);

      if (error) {
        this.log("error", "Error fetching pending predictions", {
          error: this.safeErrorMessage(error),
        });
        return;
      }

      this.log(
        "info",
        `Fetched ${rows?.length || 0} pending predictions for reconciliation`,
        {
          requestId,
        }
      );

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
          // Use target_price_in_asset_currency if available (converted value), otherwise use target_price
          const targetPriceForComparison = row.target_price;
          if (targetPriceForComparison) {
            targetPriceNum = parseFloat(String(targetPriceForComparison));
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

            // Build update object with all AI fields ensured to be set
            const updateData: Record<string, any> = {
              status: finalStatus,
              actual_price: verificationResult.actualPrice,
              resolved_at: new Date().toISOString(),
              verification_metadata: verificationResult.metDate
                ? { met_on_date: verificationResult.metDate.toISOString() }
                : {},
            };

            // Set reconciliation model if AI was used
            if (aiModelReconciliation) {
              updateData.ai_model_reconciliation = aiModelReconciliation;
              // ai_model_extraction represents the extraction model used originally
              // If reconciliation used a model, use the same for extraction for consistency
              updateData.ai_model_extraction = aiModelReconciliation;
            }

            // Set reconciliation agreement flag
            if (aiReconciliationAgrees !== null) {
              updateData.ai_reconciliation_agrees = aiReconciliationAgrees;
            }

            // Always set reasoning (even if it's the rule-based one)
            if (aiReconciliationReasoning) {
              updateData.ai_reconciliation_reasoning =
                aiReconciliationReasoning;
            } else {
              // Fallback to rule-based reasoning
              updateData.ai_reconciliation_reasoning =
                finalStatus === "correct"
                  ? "Rule-based verification: Prediction target met"
                  : "Rule-based verification: Prediction target not met";
            }

            await supabaseService.supabase
              .from("combined_predictions")
              .update(updateData)
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
              // Normalize asset name immediately (basic cleanup)
              asset = priceService.normalizeAssetName(asset);

              // Advanced normalization: Check DB for existing normalized name or ask AI
              asset = await this.getNormalizedAssetName(
                asset,
                p.prediction_text || ""
              );

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

              // Use normalized asset as ticker
              const ticker = asset;

              // Infer asset type and currency using AI classifier
              let assetType = p.asset_type;
              let currency = "USD"; // default
              let currencySymbol = "$"; // default symbol
              let tradingviewSymbol: string | null = null; // New field

              // Check DB first for existing TV symbol (cache)
              const cachedTvSymbol = await this.getExistingTvSymbol(asset);
              if (cachedTvSymbol) {
                tradingviewSymbol = cachedTvSymbol;
                this.log(
                  "info",
                  `Using cached TV symbol for ${asset}: ${cachedTvSymbol}`
                );
              }

              if (!assetType) {
                try {
                  const classification =
                    await assetClassifierService.classifyAsset(
                      asset,
                      p.prediction_text || ""
                    );
                  assetType = classification.assetType;
                  currency = classification.currency;
                  currencySymbol = classification.currencySymbol;

                  // Only use AI's TV symbol if we don't have a cached one
                  if (!tradingviewSymbol && classification.tradingviewSymbol) {
                    tradingviewSymbol = classification.tradingviewSymbol;
                  }

                  this.log("info", `Classified asset ${asset}`, {
                    assetType,
                    currency,
                    currencySymbol,
                    confidence: classification.confidence,
                  });
                } catch (classifyErr) {
                  // Fallback to basic inference if AI fails
                  this.log(
                    "warn",
                    `Asset classification failed for ${asset}, using fallback`,
                    {
                      error: this.safeErrorMessage(classifyErr),
                    }
                  );
                  assetType = this.inferAssetType(asset);
                  currency = priceService.detectCurrency(ticker, assetType);
                  currencySymbol = priceService.getCurrencySymbol(currency);
                }
              }

              // Fallback: If we still don't have a TV symbol, try algorithmic mapping
              if (!tradingviewSymbol) {
                tradingviewSymbol = priceService.mapToTradingViewSymbol(ticker);
              }

              // Fetch historical price if enabled
              // Use fallback search with 3-day lookback for initial pass (holidays/weekends)
              let entryPrice = null;
              let formattedEntryPrice = null;

              if (!skipPrice && rec.post_date) {
                const price = await priceService.searchPriceWithFallback(
                  ticker,
                  postDateObj,
                  assetType,
                  3 // maxLookbackDays for initial fetch
                );
                if (
                  price !== null &&
                  this.isValidEntryPrice(price, assetType, asset)
                ) {
                  entryPrice = String(price);
                  // Use AI-determined currency symbol from classification for proper display formatting
                  // Indices will have empty currencySymbol, other assets will have €, $, ₺, etc.
                  formattedEntryPrice = priceService.formatPriceForDisplay(
                    price,
                    currencySymbol,
                    assetType
                  );
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

              // Validate entry price is available before creating combined prediction
              if (entryPrice === null || entryPrice === undefined) {
                this.log(
                  "warn",
                  `Skipping prediction without entry price for ${asset}`,
                  {
                    videoId,
                    asset,
                    symbol: p.asset,
                  }
                );
                skipped++;
                continue;
              }

              // Handle target price currency conversion
              let targetPrice = p.target_price;
              let targetPriceCurrency = p.target_price_currency_declared;
              let targetPriceInAssetCurrency = p.target_price
                ? p.target_price
                : null;
              let currencyConversionMetadata: any = null;

              if (targetPrice !== null && targetPrice !== undefined) {
                // If no currency was explicitly declared, use the asset's default currency
                if (!targetPriceCurrency) {
                  targetPriceCurrency = currency;
                  this.log(
                    "info",
                    `No currency declared for ${asset} target price, using asset default: ${currency}`,
                    {
                      videoId,
                      asset,
                      targetPrice,
                    }
                  );
                }

                // If declared currency differs from asset currency, perform conversion
                if (targetPriceCurrency !== currency) {
                  try {
                    this.log(
                      "info",
                      `Converting target price from ${targetPriceCurrency} to ${currency}`,
                      {
                        videoId,
                        asset,
                        originalPrice: targetPrice,
                        targetCurrency: currency,
                      }
                    );

                    const conversionResult =
                      await priceService.convertPriceToCurrency(
                        targetPrice,
                        targetPriceCurrency,
                        currency,
                        postDateObj
                      );

                    if (conversionResult !== null) {
                      targetPriceInAssetCurrency = conversionResult;

                      // Get the exchange rate for metadata recording
                      const rateInfo =
                        await priceService.getExchangeRateForDate(
                          targetPriceCurrency,
                          currency,
                          postDateObj
                        );

                      currencyConversionMetadata = {
                        currency_declared: targetPriceCurrency,
                        asset_currency: currency,
                        exchange_rate_used: rateInfo.rate,
                        conversion_date: rateInfo.date_found,
                        exchange_rate_source: rateInfo.source,
                        original_target_price: targetPrice,
                        converted_target_price: targetPriceInAssetCurrency,
                        ai_extraction_reasoning:
                          p.extraction_metadata?.selected_currency_reasoning ||
                          null,
                        multiple_currencies_detected:
                          p.extraction_metadata?.multiple_currencies_detected ||
                          null,
                        currency_detection_confidence:
                          p.extraction_metadata
                            ?.currency_detection_confidence || "medium",
                      };

                      this.log("info", `Target price conversion successful`, {
                        videoId,
                        asset,
                        fromPrice: targetPrice,
                        toPrice: targetPriceInAssetCurrency,
                        rate: rateInfo.rate,
                        rateSource: rateInfo.source,
                      });
                    } else {
                      this.log(
                        "warn",
                        `Target price conversion failed, using original price`,
                        {
                          videoId,
                          asset,
                          originalPrice: targetPrice,
                          fromCurrency: targetPriceCurrency,
                          toCurrency: currency,
                        }
                      );

                      // Store failed conversion in metadata
                      currencyConversionMetadata = {
                        currency_declared: targetPriceCurrency,
                        asset_currency: currency,
                        exchange_rate_used: null,
                        conversion_date: postDateObj
                          .toISOString()
                          .split("T")[0],
                        exchange_rate_source: "failed",
                        original_target_price: targetPrice,
                        converted_target_price: null,
                        conversion_error: "Could not fetch exchange rate",
                        ai_extraction_reasoning:
                          p.extraction_metadata?.selected_currency_reasoning ||
                          null,
                        multiple_currencies_detected:
                          p.extraction_metadata?.multiple_currencies_detected ||
                          null,
                        currency_detection_confidence:
                          p.extraction_metadata
                            ?.currency_detection_confidence || "medium",
                      };
                    }
                  } catch (convErr) {
                    this.log("error", `Error during currency conversion`, {
                      err: this.safeErrorMessage(convErr),
                      videoId,
                      asset,
                    });

                    currencyConversionMetadata = {
                      currency_declared: targetPriceCurrency,
                      asset_currency: currency,
                      exchange_rate_used: null,
                      conversion_date: postDateObj.toISOString().split("T")[0],
                      exchange_rate_source: "error",
                      original_target_price: targetPrice,
                      converted_target_price: null,
                      conversion_error: this.safeErrorMessage(convErr),
                      ai_extraction_reasoning:
                        p.extraction_metadata?.selected_currency_reasoning ||
                        null,
                      multiple_currencies_detected:
                        p.extraction_metadata?.multiple_currencies_detected ||
                        null,
                      currency_detection_confidence:
                        p.extraction_metadata?.currency_detection_confidence ||
                        "medium",
                    };
                  }
                } else {
                  // Same currency, no conversion needed
                  currencyConversionMetadata = {
                    currency_declared: targetPriceCurrency,
                    asset_currency: currency,
                    exchange_rate_used: 1,
                    conversion_date: postDateObj.toISOString().split("T")[0],
                    exchange_rate_source: "cache",
                    original_target_price: targetPrice,
                    converted_target_price: targetPriceInAssetCurrency,
                    ai_extraction_reasoning:
                      p.extraction_metadata?.selected_currency_reasoning ||
                      null,
                    multiple_currencies_detected:
                      p.extraction_metadata?.multiple_currencies_detected ||
                      null,
                    currency_detection_confidence:
                      p.extraction_metadata?.currency_detection_confidence ||
                      "medium",
                  };
                }
              }

              // Create combined row with AI model extraction tracking and currency conversion
              const combinedRow = {
                channel_id: rec.channel_id,
                channel_name: rec.channel_name,
                video_id: videoId,
                post_date: postDateObj.toISOString(),
                asset,
                asset_type: assetType,
                asset_entry_price: entryPrice,
                formatted_price: formattedEntryPrice,
                price_currency: currency,
                horizon_value: p.horizon?.value || "",
                horizon_type: p.horizon?.type || "custom",
                horizon_start_date: horizonStart.toISOString(),
                horizon_end_date: horizonEnd.toISOString(),
                sentiment: p.sentiment || "neutral",
                confidence: p.confidence || "medium",
                target_price: targetPrice ? String(targetPrice) : null, // NOW CONTAINS CONVERTED PRICE - ready for comparison
                target_price_currency: targetPriceCurrency, // New field: currency declared in prediction
                necessary_conditions_for_prediction:
                  p.necessary_conditions_for_prediction || null, // New field: prediction conditions
                currency_conversion_metadata: currencyConversionMetadata
                  ? JSON.stringify(currencyConversionMetadata)
                  : null,
                prediction_text: predictionText,
                status: "pending",
                platform: "YouTube",
                ai_model_extraction: rec.ai_model || null,
                tradingview_symbol: tradingviewSymbol, // Persist TV symbol
                quality_score: p.quality_score, // Individual quality score
                quality_breakdown: p.quality_breakdown, // Individual quality breakdown
              };

              if (!dryRun) {
                // Use upsert to handle duplicates - if video_id + asset already exists, update it
                const { error: upsertError } = await supabaseService.supabase
                  .from("combined_predictions")
                  .upsert(combinedRow, {
                    onConflict: "video_id,asset",
                    ignoreDuplicates: false, // Update existing record
                  });

                if (upsertError) {
                  this.log("error", "Failed to upsert combined prediction", {
                    err: this.safeErrorMessage(upsertError),
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
   * Infer asset type from asset name (DEPRECATED - use assetClassifierService instead)
   * Kept for backward compatibility and fallback purposes only
   */
  private inferAssetType(asset: string): string {
    const upper = asset.toUpperCase().trim().replace(/\s+/g, "");

    // Quick fallback mapping for critical assets
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

    if (
      ["GOLD", "SILVER", "CRUDE", "OIL", "NATURALGAS", "BRENT", "WTI"].includes(
        upper
      )
    )
      return "commodity";

    if (
      ["EURUSD", "USDJPY", "GBPUSD", "USDTRY", "EURTRY", "XAUUSD"].includes(
        upper
      )
    )
      return "fx";

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
        "BIST75",
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
        .select("id, asset, asset_type, post_date, retry_count, last_retry_at")
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

          // Infer asset type if missing (use AI classifier)
          let assetType = row.asset_type;
          if (!assetType) {
            try {
              const classification = await assetClassifierService.classifyAsset(
                asset,
                ""
              );
              assetType = classification.assetType;
            } catch (classifyErr) {
              // Fallback to basic inference if AI fails
              this.log(
                "warn",
                `Asset classification failed for ${asset} in retry, using fallback`,
                {
                  error: this.safeErrorMessage(classifyErr),
                }
              );
              assetType = this.inferAssetType(asset);
            }
          }

          // Fetch price with fallback to previous dates (handles holidays/weekends)
          // 5-day lookback for retry (more thorough than initial 3-day pass)
          const price = await priceService.searchPriceWithFallback(
            asset,
            postDate,
            assetType,
            5 // maxLookbackDays
          );

          if (price !== null && !dryRun) {
            // Update the record
            const { error: updateError } = await supabaseService.supabase
              .from("combined_predictions")
              .update({
                asset_entry_price: String(price),
                asset_type: assetType, // Also update asset_type if it was inferred
                retry_count: (row.retry_count || 0) + 1,
                last_retry_at: new Date().toISOString(),
              })
              .eq("id", row.id);

            if (updateError) {
              this.log("error", "Error updating entry price", {
                id: row.id,
                error: updateError,
              });
              failed++;
            } else {
              this.log(
                "info",
                `Updated entry price for ${asset} via fallback search`,
                {
                  id: row.id,
                  price,
                }
              );
              updated++;
            }
          } else if (price === null) {
            this.log(
              "warn",
              `Could not fetch price for ${asset} within 5-day lookback from ${postDate.toISOString()}`,
              { id: row.id }
            );
            // Still update retry_count even on failure for tracking
            if (!dryRun) {
              const { error: retryMetaError } = await supabaseService.supabase
                .from("combined_predictions")
                .update({
                  retry_count: (row.retry_count || 0) + 1,
                  last_retry_at: new Date().toISOString(),
                })
                .eq("id", row.id);

              if (retryMetaError) {
                this.log("warn", "Failed to update retry metadata", {
                  id: row.id,
                  error: this.safeErrorMessage(retryMetaError),
                });
              }
            }
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

  /**
   * Get existing TV symbol from database for an asset (cache lookup)
   */
  private async getExistingTvSymbol(asset: string): Promise<string | null> {
    try {
      const { data } = await supabaseService.supabase
        .from("combined_predictions")
        .select("tradingview_symbol")
        .eq("asset", asset)
        .not("tradingview_symbol", "is", null)
        .limit(1)
        .single();
      return data?.tradingview_symbol || null;
    } catch {
      return null;
    }
  }

  /**
   * Get normalized asset name - checks DB cache first, then uses AI if needed
   * Converts company names to tickers (ROBINHOOD → HOOD)
   */
  private async getNormalizedAssetName(
    asset: string,
    predictionText: string
  ): Promise<string> {
    try {
      // 1. Check if we already have this asset normalized in DB
      const { data: existing } = await supabaseService.supabase
        .from("combined_predictions")
        .select("asset")
        .eq("asset", asset)
        .limit(1);

      // If asset exists in DB, it's already normalized (or at least consistent)
      if (existing && existing.length > 0) {
        return asset; // Use as-is, already in DB
      }

      // 2. Check if this is a company name that maps to an existing ticker
      // e.g., if "ROBINHOOD" comes in but we have "HOOD" in DB
      const aiNormalized = await this.askAIForNormalizedTicker(
        asset,
        predictionText
      );
      if (aiNormalized && aiNormalized !== asset) {
        // Check if the normalized ticker already exists in DB
        const { data: tickerExists } = await supabaseService.supabase
          .from("combined_predictions")
          .select("asset")
          .eq("asset", aiNormalized)
          .limit(1);

        if (tickerExists && tickerExists.length > 0) {
          this.log(
            "info",
            `Normalized asset: ${asset} → ${aiNormalized} (exists in DB)`
          );
          return aiNormalized;
        }

        // Use AI's normalized version even if new
        this.log("info", `Normalized asset: ${asset} → ${aiNormalized} (new)`);
        return aiNormalized;
      }

      return asset; // Return original if no normalization needed
    } catch (err) {
      this.log(
        "warn",
        `Asset normalization failed for ${asset}, using original`,
        {
          error: this.safeErrorMessage(err),
        }
      );
      return asset;
    }
  }

  /**
   * Ask AI to normalize an asset name to its proper ticker
   */
  private async askAIForNormalizedTicker(
    asset: string,
    predictionText: string
  ): Promise<string | null> {
    try {
      const prompt = `Given this asset name, return ONLY the proper stock/crypto ticker symbol.

ASSET: "${asset}"
CONTEXT: "${predictionText.slice(0, 200)}"

RULES:
- ROBINHOOD → HOOD
- TESLA → TSLA  
- AMAZON → AMZN
- BITCOIN → BTC
- If already a proper ticker, return as-is
- If private company (SPACEX), return as-is uppercase
- Return ONLY the ticker, nothing else`;

      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: config.openrouterModel2,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 20,
        },
        {
          headers: {
            Authorization: `Bearer ${config.openrouterApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      const result = response.data?.choices?.[0]?.message?.content
        ?.trim()
        .toUpperCase();
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * Validate entry price is within reasonable bounds for the asset type
   * Detects obviously wrong prices (e.g., SPX showing 35 instead of 6500)
   */
  private async isValidEntryPrice(
    price: number | null,
    assetType: string,
    asset: string
  ): Promise<boolean> {
    if (price === null || price === undefined || price <= 0) {
      return false;
    }

    try {
      // Dynamic Check: Compare with last known valid price
      const lastKnownPrice = await priceService.getLastKnownPrice(asset);

      // COLD START: If we have no history, we MUST trust the new price
      // This solves the issue where new assets (like XAUTRYG) were rejected by hardcoded ranges
      if (!lastKnownPrice) {
        this.log(
          "info",
          `First time seeing price for ${asset}. Trusting API.`,
          {
            asset,
            price,
          }
        );
        return true;
      }

      // DEVIATION CHECK: If we have history, ensure we didn't jump > 50%
      const deviation = Math.abs((price - lastKnownPrice) / lastKnownPrice);
      const MAX_DEVIATION = 0.5; // 50% allowed jump (handles high volatility)

      if (deviation > MAX_DEVIATION) {
        this.log(
          "warn",
          `⚠️ Price deviation too high for ${asset}. Last: ${lastKnownPrice}, New: ${price} (${(
            deviation * 100
          ).toFixed(0)}% change)`,
          { asset, price, lastKnownPrice }
        );
        return false;
      }

      return true;
    } catch (error) {
      // On error (DB fail), default to safe open (trust price) but warn
      this.log("warn", "Price validation error, trusting new price", {
        err: this.safeErrorMessage(error),
      });
      return true;
    }
  }
}

export const combinedPredictionsService = new CombinedPredictionsService();
