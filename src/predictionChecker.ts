import { supabaseService } from './supabase';
import { combinedPredictionsService } from './combinedPredictionsService';
import { logger } from './utils';

/**
 * Prediction Checker
 * - Calls reconciliation to evaluate horizon-passed predictions
 * - Increments `horizon_check_date` for pending predictions to continue checking day-by-day
 */
export async function runPredictionChecks(options: { limit?: number; dryRun?: boolean; useAI?: boolean } = {}) {
  const limit = options.limit ?? 500;
  const dryRun = options.dryRun ?? false;
  const useAI = options.useAI ?? true;

  const todayIso = new Date().toISOString().split('T')[0];

  logger.info('Starting prediction checks', { limit, dryRun, useAI });

  try {
    // Fetch pending records whose horizon_check_date is null or <= today
    const { data: rows, error } = await supabaseService.supabase
      .from('combined_predictions')
      .select('id, video_id, horizon_check_date, horizon_value, post_date, status')
      .eq('status', 'pending')
      .or(`horizon_check_date.is.null,horizon_check_date.<=.${todayIso}`)
      .limit(limit);

    if (error) {
      logger.warn('Failed to fetch pending predictions for checking', { err: error });
      return;
    }

    const count = (rows || []).length;
    logger.info('Pending predictions to check', { count });

    // Run the reconcile logic which will evaluate horizon-passed predictions
    await combinedPredictionsService.reconcilePredictions({ limit, dryRun, useAI });

    // After reconciliation, increment horizon_check_date for any still-pending records we fetched
    for (const r of rows || []) {
      try {
        const { data: fresh } = await supabaseService.supabase.from('combined_predictions').select('id,status,horizon_check_date').eq('id', r.id).single();
        if (fresh && fresh.status === 'pending') {
          // increment check date by one day
          const next = new Date();
          next.setUTCDate(next.getUTCDate() + 1);
          const nextIso = next.toISOString().split('T')[0];
          if (!dryRun) {
            const { error: upErr } = await supabaseService.supabase.from('combined_predictions').update({ horizon_check_date: nextIso }).eq('id', r.id);
            if (upErr) logger.warn('Failed to update horizon_check_date', { id: r.id, err: upErr });
          } else {
            logger.info('Dry run - would update horizon_check_date', { id: r.id, nextIso });
          }
        }
      } catch (e) {
        logger.warn('Error while post-reconciliation processing', { err: e, id: r.id });
      }
    }
  } catch (err) {
    logger.error('Prediction checker failed', { err });
  }
}

export default { runPredictionChecks };
