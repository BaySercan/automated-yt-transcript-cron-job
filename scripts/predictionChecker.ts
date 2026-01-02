import { combinedPredictionsService } from "../src/combinedPredictionsService";
import { logger } from "../src/utils";

/**
 * Prediction Checker
 * - Calls reconciliation to evaluate horizon-passed predictions
 * - Now simplified to just trigger the service, as date range logic is handled internally
 */
export async function runPredictionChecks(
  options: { limit?: number; dryRun?: boolean; useAI?: boolean } = {}
) {
  const limit = options.limit ?? 10000; // Increased from 500 to process more predictions
  const dryRun = options.dryRun ?? false;
  const useAI = options.useAI ?? true;

  logger.info("Starting prediction checks", { limit, dryRun, useAI });

  try {
    // 1. First, retry missing entry prices
    // This ensures that when we reconcile, we have as much data as possible
    await combinedPredictionsService.retryMissingEntryPrices(limit, dryRun);

    // 2. Run the reconcile logic which will evaluate horizon-passed predictions
    // The service now handles date range verification internally
    await combinedPredictionsService.reconcilePredictions({
      limit,
      dryRun,
      useAI,
    });

    logger.info("Prediction checks completed");
  } catch (err) {
    logger.error("Prediction checker failed", { err });
  }
}

export default { runPredictionChecks };
