import { supabaseService } from "../supabase";
import { youtubeService } from "../youtube";
import { globalAIAnalyzer } from "../enhancedAnalyzer";
import {
  Offering,
  EvaluationResult,
  EvaluationDetails,
  SampleVideoAnalysis,
  YouTubeVideo,
} from "../types";
import { logger, retryWithBackoff, cleanJsonResponse } from "../utils";
import { config } from "../config";
import { reportingService } from "./reportingService";
import { AvatarService } from "./avatarService";
import axios from "axios";

/**
 * Finfluencer Offering Evaluation Service
 *
 * Automatically evaluates user-submitted channel recommendations.
 * Criteria:
 * 1. Minimum 50,000 subscribers
 * 2. Minimum 50 videos in the last year
 * 3. Content is financial in nature
 * 4. Contains actionable predictions (analyzed from 10 sample videos)
 */
class OfferingEvaluationService {
  // Configuration thresholds
  private readonly MIN_SUBSCRIBERS = 50000;
  private readonly MIN_VIDEOS_LAST_YEAR = 50;
  private readonly SAMPLE_VIDEO_COUNT = 10;
  private readonly RESUBMIT_DELAY_MONTHS = 6;

  // Transcript retry configuration
  private readonly MIN_TRANSCRIPT_RATE = 0.5; // At least 50% of videos must have transcripts
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY_DAYS = 7;

  /**
   * Main entry point - called from index.ts
   * Processes all pending offerings
   */
  async processOfferings(): Promise<void> {
    logger.info("🔍 Starting finfluencer offering evaluation...");

    try {
      // Fetch pending offerings
      const offerings = await supabaseService.getPendingOfferings();

      if (offerings.length === 0) {
        logger.info("📭 No pending offerings to evaluate");
        return;
      }

      logger.info(`📋 Found ${offerings.length} offering(s) to evaluate`);

      // Also fetch offerings ready for transcript retry
      const retryOfferings = await supabaseService.getRetryOfferings();
      if (retryOfferings.length > 0) {
        logger.info(
          `🔄 Found ${retryOfferings.length} offering(s) ready for transcript retry`
        );
        offerings.push(...retryOfferings);
      }

      let processed = 0;
      let approved = 0;
      let rejected = 0;
      let retried = 0;
      let errors = 0;

      for (const offering of offerings) {
        try {
          logger.info(
            `\n${"=".repeat(60)}\n🎯 Evaluating offering: ${
              offering.channel_title || offering.channel_id
            }\n${"=".repeat(60)}`
          );

          // Mark as processing (for resumability)
          await supabaseService.markOfferingProcessing(offering.id);

          // Run evaluation
          const result = await this.evaluateOffering(offering);

          // Apply result
          await this.applyEvaluationResult(offering, result);

          processed++;
          if (result.passed) {
            approved++;
          } else if (result.needsTranscriptRetry) {
            retried++;
          } else {
            rejected++;
          }
        } catch (error) {
          errors++;
          logger.error(
            `❌ Error evaluating offering ${offering.id}: ${
              (error as Error).message
            }`,
            { error }
          );

          // Mark as rejected with error
          try {
            await supabaseService.updateOfferingEvaluation(offering.id, {
              status: "rejected",
              subscriberCount: 0,
              videoCountLastYear: 0,
              rejectionReason: `Evaluation error: ${(error as Error).message}`,
              evaluationDetails: {
                channel_info: {
                  title: offering.channel_title || "Unknown",
                  description: "",
                  subscriber_count: 0,
                  total_videos: 0,
                  videos_last_year: 0,
                },
                content_analysis: {
                  is_financial: false,
                  confidence: 0,
                  topics_detected: [],
                  sample_titles_analyzed: 0,
                },
                prediction_analysis: {
                  has_predictions: false,
                  quality_score: 0,
                  videos_analyzed: 0,
                  videos_with_predictions: 0,
                  sample_videos: [],
                  ai_reasoning: `Error during evaluation: ${
                    (error as Error).message
                  }`,
                },
                final_decision: {
                  result: "rejected",
                  reason: `Evaluation error: ${(error as Error).message}`,
                  decided_at: new Date().toISOString(),
                },
              },
              canResubmitAfter: this.getResubmitDate(),
            });
          } catch (updateError) {
            logger.error(
              `Failed to update error status for offering ${offering.id}`,
              { error: updateError }
            );
          }
        }
      }

      logger.info(`\n${"=".repeat(60)}`);
      logger.info(`📊 Offering Evaluation Summary:`);
      logger.info(`   Processed: ${processed}`);
      logger.info(`   Approved: ${approved}`);
      logger.info(`   Rejected: ${rejected}`);
      logger.info(`   Needs Retry: ${retried}`);
      logger.info(`   Errors: ${errors}`);
      logger.info(`${"=".repeat(60)}\n`);

      // Update reporting service
      reportingService.updateOfferings({
        processed,
        approved,
        rejected,
        errors,
      });
    } catch (error) {
      logger.error("❌ Failed to process offerings", { error });
      throw error;
    }
  }

  /**
   * Evaluate a single offering against all criteria
   */
  private async evaluateOffering(
    offering: Offering
  ): Promise<EvaluationResult> {
    const details: Partial<EvaluationDetails> = {};

    // Step 1: Get channel details and check subscriber count
    logger.info(`📊 Step 1: Checking channel statistics...`);
    const channelDetails = await youtubeService.getChannelDetails(
      offering.channel_id
    );

    const subscriberCount = channelDetails.subscriberCount || 0;
    const totalVideos = channelDetails.videoCount || 0;

    details.channel_info = {
      title: channelDetails.title,
      description: channelDetails.description || "",
      subscriber_count: subscriberCount,
      total_videos: totalVideos,
      videos_last_year: 0, // Will be filled in step 2
    };

    logger.info(
      `   Subscriber count: ${subscriberCount.toLocaleString()} (min: ${this.MIN_SUBSCRIBERS.toLocaleString()})`
    );

    // Fail fast: Check subscriber count
    if (subscriberCount < this.MIN_SUBSCRIBERS) {
      return this.createRejectionResult(
        `Insufficient subscribers: ${subscriberCount.toLocaleString()} (minimum: ${this.MIN_SUBSCRIBERS.toLocaleString()})`,
        details as EvaluationDetails,
        subscriberCount,
        0
      );
    }

    // Step 2: Get videos from last year and check count
    logger.info(`📊 Step 2: Checking video count in last 365 days...`);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const videosLastYear = await youtubeService.getChannelVideos(
      offering.channel_id,
      oneYearAgo
    );

    const videoCountLastYear = videosLastYear.length;
    details.channel_info!.videos_last_year = videoCountLastYear;

    logger.info(
      `   Videos in last year: ${videoCountLastYear} (min: ${this.MIN_VIDEOS_LAST_YEAR})`
    );

    // Fail fast: Check video count
    if (videoCountLastYear < this.MIN_VIDEOS_LAST_YEAR) {
      return this.createRejectionResult(
        `Insufficient content: ${videoCountLastYear} videos in last year (minimum: ${this.MIN_VIDEOS_LAST_YEAR})`,
        details as EvaluationDetails,
        subscriberCount,
        videoCountLastYear
      );
    }

    // Step 3: Check if content is financial
    logger.info(`📊 Step 3: Analyzing content relevance (AI)...`);
    const contentAnalysis = await this.analyzeContentRelevance(
      channelDetails,
      videosLastYear.slice(0, 20) // Check first 20 video titles
    );

    details.content_analysis = contentAnalysis;

    logger.info(
      `   Financial content: ${
        contentAnalysis.is_financial ? "Yes" : "No"
      } (confidence: ${contentAnalysis.confidence})`
    );
    logger.info(
      `   Topics detected: ${contentAnalysis.topics_detected.join(", ")}`
    );

    // Fail fast: Check financial content
    if (!contentAnalysis.is_financial) {
      return this.createRejectionResult(
        `Not financial content: Channel does not primarily focus on financial topics`,
        details as EvaluationDetails,
        subscriberCount,
        videoCountLastYear
      );
    }

    // Step 4: Analyze sample videos for predictions
    logger.info(
      `📊 Step 4: Analyzing ${this.SAMPLE_VIDEO_COUNT} sample videos for predictions...`
    );
    const predictionAnalysis = await this.analyzePredictionQuality(
      videosLastYear.slice(0, this.SAMPLE_VIDEO_COUNT)
    );

    details.prediction_analysis = predictionAnalysis;

    logger.info(
      `   Has predictions: ${predictionAnalysis.has_predictions ? "Yes" : "No"}`
    );
    logger.info(
      `   Videos with predictions: ${predictionAnalysis.videos_with_predictions}/${predictionAnalysis.videos_analyzed}`
    );
    logger.info(`   Quality score: ${predictionAnalysis.quality_score}`);
    logger.info(
      `   Transcript availability: ${
        predictionAnalysis.transcript_rate
      }% (min: ${this.MIN_TRANSCRIPT_RATE * 100}%)`
    );

    // Check if we need to retry due to low transcript availability
    const currentRetryCount = offering.retry_count || 0;
    if (predictionAnalysis.needs_retry) {
      if (currentRetryCount >= this.MAX_RETRY_ATTEMPTS) {
        // Max retries exceeded - reject with clear reason
        logger.info(
          `❌ Max retry attempts (${this.MAX_RETRY_ATTEMPTS}) exceeded - rejecting`
        );
        return this.createRejectionResult(
          `Insufficient transcript data after ${
            this.MAX_RETRY_ATTEMPTS
          } retry attempts. Only ${Math.round(
            predictionAnalysis.transcript_rate * 100
          )}% of videos had transcripts available.`,
          details as EvaluationDetails,
          subscriberCount,
          videoCountLastYear
        );
      }

      // Need retry - return special result
      logger.info(
        `🔄 Insufficient transcripts - scheduling retry (attempt ${
          currentRetryCount + 1
        }/${this.MAX_RETRY_ATTEMPTS})`
      );

      details.final_decision = {
        result: "needs_retry",
        reason: `Only ${Math.round(
          predictionAnalysis.transcript_rate * 100
        )}% of videos had transcripts available (minimum: ${
          this.MIN_TRANSCRIPT_RATE * 100
        }%). Will retry in ${this.RETRY_DELAY_DAYS} days.`,
        decided_at: new Date().toISOString(),
      };

      return {
        passed: false,
        subscriberCount,
        videoCountLastYear,
        isFinancialContent: true,
        hasPredictions: false,
        needsTranscriptRetry: true,
        details: details as EvaluationDetails,
      };
    }

    // Check prediction quality (only if we have enough transcripts)
    if (!predictionAnalysis.has_predictions) {
      return this.createRejectionResult(
        `No actionable predictions: Channel content does not contain specific financial predictions`,
        details as EvaluationDetails,
        subscriberCount,
        videoCountLastYear
      );
    }

    // All checks passed - APPROVED!
    logger.info(`✅ All criteria passed - Channel APPROVED!`);

    details.final_decision = {
      result: "approved",
      reason: null,
      decided_at: new Date().toISOString(),
    };

    return {
      passed: true,
      subscriberCount,
      videoCountLastYear,
      isFinancialContent: true,
      hasPredictions: true,
      details: details as EvaluationDetails,
    };
  }

  /**
   * Analyze channel content relevance using AI
   */
  private async analyzeContentRelevance(
    channelDetails: any,
    sampleVideos: YouTubeVideo[]
  ): Promise<{
    is_financial: boolean;
    confidence: number;
    topics_detected: string[];
    sample_titles_analyzed: number;
  }> {
    const videoTitles = sampleVideos.map((v) => v.title).join("\n- ");

    const prompt = `Analyze this YouTube channel to determine if it primarily focuses on FINANCIAL content.

Channel Name: ${channelDetails.title}
Channel Description: ${channelDetails.description || "No description"}

Sample Video Titles (${sampleVideos.length} most recent):
- ${videoTitles}

Evaluate if this channel focuses on:
- Stock market analysis and predictions
- Cryptocurrency/crypto trading
- Forex trading
- Economic analysis
- Investment advice
- Personal finance
- Commodity trading (gold, oil, etc.)

Respond in JSON format:
{
  "is_financial": true/false,
  "confidence": 0.0-1.0,
  "topics_detected": ["stocks", "crypto", ...],
  "reasoning": "Brief explanation"
}`;

    try {
      const response = await this.sendAIRequest(prompt);
      const cleaned = cleanJsonResponse(response);
      const result = JSON.parse(cleaned);

      return {
        is_financial: result.is_financial === true,
        confidence:
          typeof result.confidence === "number" ? result.confidence : 0.5,
        topics_detected: Array.isArray(result.topics_detected)
          ? result.topics_detected
          : [],
        sample_titles_analyzed: sampleVideos.length,
      };
    } catch (error) {
      logger.error("Error analyzing content relevance", { error });
      // Conservative fallback - don't reject just because AI failed
      return {
        is_financial: true, // Give benefit of doubt
        confidence: 0.3,
        topics_detected: ["unknown"],
        sample_titles_analyzed: sampleVideos.length,
      };
    }
  }

  /**
   * Analyze sample videos for prediction quality
   */
  private async analyzePredictionQuality(videos: YouTubeVideo[]): Promise<{
    has_predictions: boolean;
    quality_score: number;
    videos_analyzed: number;
    videos_with_predictions: number;
    sample_videos: SampleVideoAnalysis[];
    ai_reasoning: string;
    transcript_rate: number; // Percentage of videos with transcripts (0-1)
    needs_retry: boolean; // True if transcript rate is below minimum threshold
  }> {
    const sampleResults: SampleVideoAnalysis[] = [];
    let videosWithPredictions = 0;
    let totalPredictions = 0;

    for (const video of videos) {
      logger.info(`   Analyzing: ${video.title.substring(0, 50)}...`);

      try {
        // Get transcript
        const { transcript, error } = await youtubeService.getVideoTranscript(
          video.videoId
        );

        if (!transcript || transcript.trim().length === 0) {
          sampleResults.push({
            video_id: video.videoId,
            title: video.title,
            predictions_found: 0,
            transcript_available: false,
            is_financial: false,
          });
          continue;
        }

        // Analyze with AI
        const analysisResult = await globalAIAnalyzer.analyzeTranscript(
          transcript,
          {
            videoId: video.videoId,
            title: video.title,
            channelId: video.channelId,
            channelName: video.channelTitle,
            publishedAt: video.publishedAt,
            defaultLanguage: video.defaultLanguage,
            defaultAudioLanguage: video.defaultAudioLanguage,
          }
        );

        const predictionsFound = analysisResult.predictions?.length || 0;
        const isFinancial = analysisResult.subject_outcome !== "out_of_subject";

        if (predictionsFound > 0) {
          videosWithPredictions++;
          totalPredictions += predictionsFound;
        }

        sampleResults.push({
          video_id: video.videoId,
          title: video.title,
          predictions_found: predictionsFound,
          transcript_available: true,
          is_financial: isFinancial,
        });

        // Add delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error(`Error analyzing video ${video.videoId}`, { error });
        sampleResults.push({
          video_id: video.videoId,
          title: video.title,
          predictions_found: 0,
          transcript_available: false,
          is_financial: false,
        });
      }
    }

    // Calculate quality score (0-100)
    // Based on: % of videos with predictions and average predictions per video
    const videosAnalyzed = sampleResults.length;
    const videosWithTranscripts = sampleResults.filter(
      (v) => v.transcript_available
    ).length;

    // Calculate transcript availability rate
    const transcriptRate =
      videosAnalyzed > 0 ? videosWithTranscripts / videosAnalyzed : 0;

    // Check if we need retry due to insufficient transcripts
    const needsRetry = transcriptRate < this.MIN_TRANSCRIPT_RATE;

    const predictionRate =
      videosWithTranscripts > 0
        ? videosWithPredictions / videosWithTranscripts
        : 0;
    const qualityScore = Math.round(predictionRate * 100);

    // Channel needs at least 30% of videos to have predictions
    const hasPredictions = predictionRate >= 0.3 && videosWithPredictions >= 2;

    let reasoning = "";
    if (needsRetry) {
      reasoning = `Insufficient transcripts: Only ${videosWithTranscripts}/${videosAnalyzed} videos (${Math.round(
        transcriptRate * 100
      )}%) had transcripts available. Minimum ${
        this.MIN_TRANSCRIPT_RATE * 100
      }% required for evaluation.`;
    } else if (hasPredictions) {
      reasoning = `Channel shows consistent prediction content: ${videosWithPredictions}/${videosWithTranscripts} analyzed videos contain predictions (${Math.round(
        predictionRate * 100
      )}%). Total ${totalPredictions} predictions found.`;
    } else {
      reasoning = `Insufficient prediction content: Only ${videosWithPredictions}/${videosWithTranscripts} analyzed videos contain predictions (${Math.round(
        predictionRate * 100
      )}%). Minimum 30% required with at least 2 videos.`;
    }

    return {
      has_predictions: hasPredictions,
      quality_score: qualityScore,
      videos_analyzed: videosAnalyzed,
      videos_with_predictions: videosWithPredictions,
      sample_videos: sampleResults,
      ai_reasoning: reasoning,
      transcript_rate: transcriptRate,
      needs_retry: needsRetry,
    };
  }

  /**
   * Apply evaluation result - update offering and add channel if approved
   */
  private async applyEvaluationResult(
    offering: Offering,
    result: EvaluationResult
  ): Promise<void> {
    if (result.passed) {
      // Approved - add channel to finfluencer_channels
      logger.info(`🎉 Adding approved channel to finfluencer_channels...`);

      // Get full channel details for storage
      const channelDetails = await youtubeService.getChannelDetails(
        offering.channel_id
      );

      // Upload avatar
      let avatarUrl: string | null = null;
      const thumbnailUrl = AvatarService.getHighResThumbnail(
        channelDetails.raw
      );
      if (thumbnailUrl) {
        avatarUrl = await supabaseService.uploadChannelAvatar(
          offering.channel_id,
          thumbnailUrl
        );
      }

      // Add channel
      await supabaseService.addFinfluencerChannel({
        channel_id: offering.channel_id,
        channel_name: channelDetails.title,
        is_active: true,
        channel_info: channelDetails.raw,
        channel_info_update_date: new Date().toISOString(),
        avatar_url: avatarUrl,
        added_at: new Date().toISOString(),
        last_checked_at: null,
      });

      // Update offering status
      await supabaseService.updateOfferingEvaluation(offering.id, {
        status: "approved",
        subscriberCount: result.subscriberCount,
        videoCountLastYear: result.videoCountLastYear,
        evaluationDetails: result.details,
      });
    } else if (result.needsTranscriptRetry) {
      // Needs transcript retry - schedule for later evaluation
      const currentRetryCount = (offering.retry_count || 0) + 1;
      const nextRetryDate = this.getNextRetryDate();

      logger.info(
        `🔄 Scheduling transcript retry #${currentRetryCount} for ${nextRetryDate}`
      );

      await supabaseService.markOfferingForRetry(offering.id, {
        retryCount: currentRetryCount,
        nextRetryAt: nextRetryDate,
        subscriberCount: result.subscriberCount,
        videoCountLastYear: result.videoCountLastYear,
        evaluationDetails: result.details,
      });
    } else {
      // Rejected
      await supabaseService.updateOfferingEvaluation(offering.id, {
        status: "rejected",
        subscriberCount: result.subscriberCount,
        videoCountLastYear: result.videoCountLastYear,
        rejectionReason: result.rejectionReason,
        evaluationDetails: result.details,
        canResubmitAfter: this.getResubmitDate(),
      });
    }
  }

  /**
   * Create a rejection result with consistent structure
   */
  private createRejectionResult(
    reason: string,
    partialDetails: Partial<EvaluationDetails>,
    subscriberCount: number,
    videoCountLastYear: number
  ): EvaluationResult {
    logger.info(`❌ Rejected: ${reason}`);

    // Fill in missing sections with defaults
    const details: EvaluationDetails = {
      channel_info: partialDetails.channel_info || {
        title: "Unknown",
        description: "",
        subscriber_count: subscriberCount,
        total_videos: 0,
        videos_last_year: videoCountLastYear,
      },
      content_analysis: partialDetails.content_analysis || {
        is_financial: false,
        confidence: 0,
        topics_detected: [],
        sample_titles_analyzed: 0,
      },
      prediction_analysis: partialDetails.prediction_analysis || {
        has_predictions: false,
        quality_score: 0,
        videos_analyzed: 0,
        videos_with_predictions: 0,
        sample_videos: [],
        ai_reasoning: "Not analyzed due to earlier failure",
      },
      final_decision: {
        result: "rejected",
        reason: reason,
        decided_at: new Date().toISOString(),
      },
    };

    return {
      passed: false,
      subscriberCount,
      videoCountLastYear,
      isFinancialContent:
        partialDetails.content_analysis?.is_financial || false,
      hasPredictions: false,
      rejectionReason: reason,
      details,
    };
  }

  /**
   * Calculate resubmit date (6 months from now)
   */
  private getResubmitDate(): string {
    const date = new Date();
    date.setMonth(date.getMonth() + this.RESUBMIT_DELAY_MONTHS);
    return date.toISOString();
  }

  /**
   * Calculate next retry date (RETRY_DELAY_DAYS from now)
   */
  private getNextRetryDate(): string {
    const date = new Date();
    date.setDate(date.getDate() + this.RETRY_DELAY_DAYS);
    return date.toISOString();
  }

  /**
   * Send AI request using OpenRouter
   */
  private async sendAIRequest(prompt: string): Promise<string> {
    const response = await retryWithBackoff(
      async () => {
        const result = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model: config.openrouterModel,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 500,
            temperature: 0.3,
          },
          {
            headers: {
              Authorization: `Bearer ${config.openrouterApiKey}`,
              "Content-Type": "application/json",
            },
          }
        );

        return result.data.choices?.[0]?.message?.content || "";
      },
      3,
      1000
    );

    return response;
  }
}

export const offeringEvaluationService = new OfferingEvaluationService();
