import { RunReport } from "../types";
import { logger, getMemoryUsage } from "../utils";
import { supabaseService } from "../supabase";

/**
 * Centralized Reporting Service
 * Tracks metrics across all pipeline stages and provides beautiful CLI output
 */
class ReportingService {
  private report: RunReport;
  private readonly APP_VERSION = "2.0.24";

  constructor() {
    this.report = this.createEmptyReport();
  }

  /**
   * Initialize a new report at the start of a run
   */
  initialize(): void {
    this.report = this.createEmptyReport();
    this.report.run_id = this.generateRunId();
    this.report.started_at = new Date().toISOString();
    this.report.status = "running";
    this.report.version = this.APP_VERSION;
  }

  private createEmptyReport(): RunReport {
    return {
      run_id: "",
      started_at: "",
      finished_at: "",
      duration_ms: 0,
      status: "running",
      version: this.APP_VERSION,
      channels: { total: 0, processed: 0, errors: 0 },
      videos: { total: 0, processed: 0, skipped: 0, errors: 0 },
      transcripts: {
        fetched: 0,
        failed: 0,
        source: "",
        avg_length_chars: 0,
        total_chars: 0,
      },
      ai_analysis: {
        processed: 0,
        predictions_extracted: 0,
        out_of_subject: 0,
        errors: 0,
      },
      combined_predictions: {
        processed: 0,
        inserted: 0,
        skipped_duplicates: 0,
        errors: 0,
      },
      price_fetching: {
        requests: 0,
        cache_hits: 0,
        api_calls: 0,
        success: 0,
        failed: 0,
        source: "",
      },
      verification: {
        processed: 0,
        resolved_correct: 0,
        resolved_wrong: 0,
        still_pending: 0,
      },
      news: {
        feeds_checked: 0,
        items_found: 0,
        items_processed: 0,
        items_saved: 0,
        non_financial: 0,
        errors: 0,
      },
      offerings: {
        processed: 0,
        approved: 0,
        rejected: 0,
        errors: 0,
      },
      system: { memory_used_mb: 0, errors: [] },
    };
  }

  private generateRunId(): string {
    return `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .substring(2, 8)}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // INCREMENT METHODS
  // ═══════════════════════════════════════════════════════════════

  // Channels
  setTotalChannels(count: number): void {
    this.report.channels.total = count;
  }
  incrementChannelsProcessed(): void {
    this.report.channels.processed++;
  }
  incrementChannelErrors(): void {
    this.report.channels.errors++;
  }

  // Videos
  setTotalVideos(count: number): void {
    this.report.videos.total = count;
  }
  incrementVideosProcessed(): void {
    this.report.videos.processed++;
  }
  incrementVideosSkipped(): void {
    this.report.videos.skipped++;
  }
  incrementVideoErrors(): void {
    this.report.videos.errors++;
  }

  // Transcripts
  incrementTranscriptsFetched(source: string, charLength: number): void {
    this.report.transcripts.fetched++;
    this.report.transcripts.source = source;
    this.report.transcripts.total_chars += charLength;
    this.report.transcripts.avg_length_chars = Math.round(
      this.report.transcripts.total_chars / this.report.transcripts.fetched
    );
  }
  incrementTranscriptsFailed(): void {
    this.report.transcripts.failed++;
  }

  // AI Analysis
  incrementAIProcessed(): void {
    this.report.ai_analysis.processed++;
  }
  addPredictionsExtracted(count: number): void {
    this.report.ai_analysis.predictions_extracted += count;
  }
  incrementOutOfSubject(): void {
    this.report.ai_analysis.out_of_subject++;
  }
  incrementAIErrors(): void {
    this.report.ai_analysis.errors++;
  }

  // Combined Predictions
  incrementCombinedProcessed(): void {
    this.report.combined_predictions.processed++;
  }
  addCombinedInserted(count: number): void {
    this.report.combined_predictions.inserted += count;
  }
  addCombinedSkipped(count: number): void {
    this.report.combined_predictions.skipped_duplicates += count;
  }
  incrementCombinedErrors(): void {
    this.report.combined_predictions.errors++;
  }

  // Price Fetching
  incrementPriceRequest(): void {
    this.report.price_fetching.requests++;
  }
  incrementPriceCacheHit(): void {
    this.report.price_fetching.cache_hits++;
  }
  incrementPriceApiCall(source: string): void {
    this.report.price_fetching.api_calls++;
    this.report.price_fetching.source = source;
  }
  incrementPriceSuccess(): void {
    this.report.price_fetching.success++;
  }
  incrementPriceFailed(): void {
    this.report.price_fetching.failed++;
  }

  // Verification
  incrementVerificationProcessed(): void {
    this.report.verification.processed++;
  }
  incrementVerificationCorrect(): void {
    this.report.verification.resolved_correct++;
  }
  incrementVerificationWrong(): void {
    this.report.verification.resolved_wrong++;
  }
  incrementVerificationPending(): void {
    this.report.verification.still_pending++;
  }

  // News
  incrementNewsFeedsChecked(): void {
    this.report.news.feeds_checked++;
  }
  addNewsItemsFound(count: number): void {
    this.report.news.items_found += count;
  }
  incrementNewsProcessed(): void {
    this.report.news.items_processed++;
  }
  incrementNewsSaved(): void {
    this.report.news.items_saved++;
  }
  incrementNewsNonFinancial(): void {
    this.report.news.non_financial++;
  }
  incrementNewsErrors(): void {
    this.report.news.errors++;
  }

  // Offerings
  updateOfferings(stats: {
    processed: number;
    approved: number;
    rejected: number;
    errors: number;
  }): void {
    this.report.offerings.processed = stats.processed;
    this.report.offerings.approved = stats.approved;
    this.report.offerings.rejected = stats.rejected;
    this.report.offerings.errors = stats.errors;
  }

  // System
  addError(message: string): void {
    if (this.report.system.errors.length < 10) {
      this.report.system.errors.push(message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FINALIZE & OUTPUT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Finalize the report and determine status
   */
  finalize(status?: "success" | "partial" | "failed"): void {
    this.report.finished_at = new Date().toISOString();
    this.report.duration_ms =
      new Date(this.report.finished_at).getTime() -
      new Date(this.report.started_at).getTime();

    const memory = getMemoryUsage();
    this.report.system.memory_used_mb = memory.used;

    // Auto-determine status if not provided
    if (status) {
      this.report.status = status;
    } else {
      const hasErrors =
        this.report.system.errors.length > 0 ||
        this.report.channels.errors > 0 ||
        this.report.videos.errors > 0;
      const hasProcessed = this.report.videos.processed > 0;

      if (!hasProcessed && hasErrors) {
        this.report.status = "failed";
      } else if (hasErrors) {
        this.report.status = "partial";
      } else {
        this.report.status = "success";
      }
    }
  }

  /**
   * Get the current report
   */
  getReport(): RunReport {
    return { ...this.report };
  }

  /**
   * Save report to database
   */
  private hasPersisted = false;

  /**
   * Save report to database (Insert or Update)
   */
  async save(): Promise<void> {
    try {
      if (!this.report.run_id) {
        logger.warn("Cannot save report: run_id is missing");
        return;
      }

      // Update timestamp
      this.report.duration_ms =
        new Date().getTime() - new Date(this.report.started_at).getTime();

      let error: any;

      if (!this.hasPersisted) {
        // First save: INSERT
        const result = await supabaseService.supabase
          .from("run_reports")
          .insert({
            run_id: this.report.run_id,
            started_at: this.report.started_at || new Date().toISOString(),
            finished_at: this.report.finished_at || null,
            duration_ms: this.report.duration_ms,
            status: this.report.status,
            report: this.report,
          });
        error = result.error;

        if (!error) {
          this.hasPersisted = true;
          logger.debug(`📝 Created run report ${this.report.run_id}`);
        }
      } else {
        // Subsequent save: UPDATE
        const result = await supabaseService.supabase
          .from("run_reports")
          .update({
            finished_at: this.report.finished_at || null,
            duration_ms: this.report.duration_ms,
            status: this.report.status,
            report: this.report,
          })
          .eq("run_id", this.report.run_id);
        error = result.error;

        if (!error) {
          logger.debug(`📝 Updated run report ${this.report.run_id}`);
        }
      }

      if (error) {
        logger.warn("Failed to save run report to database", {
          error: error.message,
        });
      }
    } catch (err: any) {
      logger.warn("Error saving run report", { error: err.message });
    }
  }

  /**
   * Print beautiful CLI output
   */
  printCLI(): void {
    const r = this.report;
    const duration = (r.duration_ms / 1000).toFixed(1);
    const statusIcon =
      r.status === "success" ? "✅" : r.status === "partial" ? "⚠️" : "❌";
    const statusText = r.status.toUpperCase();

    const line = "═".repeat(64);
    const thinLine = "─".repeat(64);

    console.log("");
    console.log(`╔${line}╗`);
    console.log(`║${"📊 RUN REPORT".padStart(38).padEnd(64)}║`);
    console.log(`╠${line}╣`);
    console.log(`║ Run ID:   ${r.run_id.padEnd(52)}║`);
    console.log(`║ Duration: ${(duration + "s").padEnd(52)}║`);
    console.log(`║ Status:   ${(statusIcon + " " + statusText).padEnd(52)}║`);
    console.log(`╠${line}╣`);

    // Row 1: Channels | Videos | Transcripts
    console.log(
      `║ ${"CHANNELS".padEnd(20)}│ ${"VIDEOS".padEnd(
        20
      )}│ ${"TRANSCRIPTS".padEnd(18)} ║`
    );
    console.log(
      `║ Total: ${String(r.channels.total).padEnd(13)}│ Total: ${String(
        r.videos.total
      ).padEnd(13)}│ Fetched: ${String(r.transcripts.fetched).padEnd(9)} ║`
    );
    console.log(
      `║ Processed: ${String(r.channels.processed).padEnd(
        9
      )}│ Processed: ${String(r.videos.processed).padEnd(9)}│ Failed: ${String(
        r.transcripts.failed
      ).padEnd(10)} ║`
    );
    console.log(
      `║ Errors: ${String(r.channels.errors).padEnd(12)}│ Skipped: ${String(
        r.videos.skipped
      ).padEnd(11)}│ Source: ${r.transcripts.source
        .padEnd(10)
        .substring(0, 10)} ║`
    );
    console.log(`╠${line}╣`);

    // Row 2: AI Analysis | Combined Predictions | Prices
    console.log(
      `║ ${"AI ANALYSIS".padEnd(20)}│ ${"PREDICTIONS".padEnd(
        20
      )}│ ${"PRICES".padEnd(18)} ║`
    );
    console.log(
      `║ Processed: ${String(r.ai_analysis.processed).padEnd(
        9
      )}│ Inserted: ${String(r.combined_predictions.inserted).padEnd(
        10
      )}│ Requests: ${String(r.price_fetching.requests).padEnd(8)} ║`
    );
    console.log(
      `║ Extracted: ${String(r.ai_analysis.predictions_extracted).padEnd(
        9
      )}│ Duplicates: ${String(
        r.combined_predictions.skipped_duplicates
      ).padEnd(8)}│ Cache: ${String(r.price_fetching.cache_hits).padEnd(11)} ║`
    );
    console.log(
      `║ OutOfSubj: ${String(r.ai_analysis.out_of_subject).padEnd(
        9
      )}│ Errors: ${String(r.combined_predictions.errors).padEnd(
        12
      )}│ Success: ${String(r.price_fetching.success).padEnd(9)} ║`
    );
    console.log(`╠${line}╣`);

    // Row 3: Verification | News | System
    console.log(
      `║ ${"VERIFICATION".padEnd(20)}│ ${"NEWS".padEnd(20)}│ ${"SYSTEM".padEnd(
        18
      )} ║`
    );
    console.log(
      `║ Correct: ${String(r.verification.resolved_correct).padEnd(
        11
      )}│ Found: ${String(r.news.items_found).padEnd(13)}│ Memory: ${String(
        r.system.memory_used_mb + " MB"
      ).padEnd(9)} ║`
    );
    console.log(
      `║ Wrong: ${String(r.verification.resolved_wrong).padEnd(
        13
      )}│ Saved: ${String(r.news.items_saved).padEnd(13)}│ Errors: ${String(
        r.system.errors.length
      ).padEnd(9)} ║`
    );
    console.log(
      `║ Pending: ${String(r.verification.still_pending).padEnd(
        11
      )}│ NonFin: ${String(r.news.non_financial).padEnd(12)}│${"".padEnd(18)} ║`
    );
    console.log(`╚${line}╝`);
    console.log("");
  }
}

export const reportingService = new ReportingService();
