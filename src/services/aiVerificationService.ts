/**
 * AI Verification Service
 *
 * Replaces hardcoded verification logic with AI-powered verification
 * that uses full context including raw transcripts for accurate prediction evaluation.
 *
 * Key features:
 * - Gathers complete context (prediction, video, transcript, prices)
 * - Validates and corrects horizon dates
 * - Provides structured verification results with reasoning
 * - Stores full audit trail in database
 */

import { logger } from "../utils";
import { config } from "../config";
import { supabaseService } from "../supabase";
import { priceService } from "./priceService";
import { globalAIAnalyzer } from "../enhancedAnalyzer";

// ============ TYPES ============

export interface VerificationContext {
  prediction: {
    id: string;
    asset: string;
    assetType: string;
    sentiment: "bullish" | "bearish" | "neutral";
    predictionText: string;
    horizonValue: string;
    horizonType: string;
    targetPrice: number | null;
    conditions: string | null;
    confidence: "low" | "medium" | "high";
  };

  video: {
    videoId: string;
    title: string;
    channelName: string;
    postDate: string;
    language: string;
  };

  rawTranscript: string | null;

  prices: {
    entryPrice: number | null;
    entryPriceDate: string;
    currentPrice: number | null;
    priceHistory: Array<{ date: string; price: number }>;
    priceChangePercent: number | null;
  };

  currentHorizon: {
    horizonStart: string;
    horizonEnd: string;
  };
}

export interface AIVerificationResult {
  status: "correct" | "wrong" | "pending";
  confidence: "low" | "medium" | "high";
  reasoning: string;

  correctedHorizon: {
    horizonStart: string;
    horizonEnd: string;
    wasCorrected: boolean;
    correctionReason: string | null;
  };

  interpretation: {
    interpretedTarget: string;
    successCriteria: string;
  };

  evidence: {
    targetMet: boolean | null;
    targetMetDate: string | null;
    highestPrice: number | null;
    lowestPrice: number | null;
  };

  flags: {
    hedgedLanguage: boolean;
    conditionalPrediction: boolean;
    conditionsMet: boolean | null;
  };

  // Corrections for prediction data
  corrections: {
    // Exact prediction text from transcript (no modifications, exactly what finfluencer said)
    correctedPredictionText: string | null;
    predictionTextWasCorrected: boolean;
    predictionTextCorrectionReason: string | null;

    // Corrected asset type if wrong
    correctedAssetType: string | null;
    assetTypeWasCorrected: boolean;
    assetTypeCorrectionReason: string | null;

    // Corrected horizon value if invalid (e.g., "yılbaşından bugüne" is not a future horizon)
    correctedHorizonValue: string | null;
    horizonValueWasCorrected: boolean;
    horizonValueCorrectionReason: string | null;
  };
}

// ============ SERVICE ============

class AIVerificationService {
  /**
   * Gather all context needed for AI verification
   */
  async gatherContext(
    predictionId: string
  ): Promise<VerificationContext | null> {
    try {
      // 1. Fetch combined prediction data
      const { data: prediction, error: predError } =
        await supabaseService.supabase
          .from("combined_predictions")
          .select(
            `id, video_id, asset, asset_type, sentiment, prediction_text,
           horizon_value, horizon_type, horizon_start_date, horizon_end_date,
           target_price, asset_entry_price, post_date, channel_name`
          )
          .eq("id", predictionId)
          .single();

      if (predError || !prediction) {
        logger.error(`Failed to fetch prediction ${predictionId}`, {
          error: predError,
        });
        return null;
      }

      // 2. Fetch video data and raw transcript from finfluencer_predictions
      const { data: videoData, error: videoError } =
        await supabaseService.supabase
          .from("finfluencer_predictions")
          .select(
            "video_id, video_title, language, raw_transcript, predictions"
          )
          .eq("video_id", prediction.video_id)
          .single();

      // 3. Find matching prediction text in the predictions array to get conditions
      let conditions: string | null = null;
      let confidence: "low" | "medium" | "high" = "medium";

      if (videoData?.predictions && Array.isArray(videoData.predictions)) {
        const matchingPred = videoData.predictions.find(
          (p: any) => p.asset?.toLowerCase() === prediction.asset?.toLowerCase()
        );
        if (matchingPred) {
          conditions = matchingPred.necessary_conditions_for_prediction || null;
          confidence = matchingPred.confidence || "medium";
        }
      }

      // 4. Calculate horizon dates
      const postDate = new Date(prediction.post_date);
      const horizonValue = prediction.horizon_value || "1 month";
      const horizonType = prediction.horizon_type || "custom";

      let horizonStart: Date;
      let horizonEnd: Date;

      if (prediction.horizon_start_date && prediction.horizon_end_date) {
        horizonStart = new Date(prediction.horizon_start_date);
        horizonEnd = new Date(prediction.horizon_end_date);
      } else {
        const calculated = priceService.calculateHorizonDateRange(
          postDate,
          horizonValue,
          horizonType
        );
        horizonStart = calculated.start;
        horizonEnd = calculated.end;
      }

      // 5. Fetch price history for the horizon period
      const now = new Date();
      const checkEnd = horizonEnd > now ? now : horizonEnd;

      const priceMap = await priceService.getPriceRangeBatch(
        prediction.asset,
        horizonStart,
        checkEnd,
        prediction.asset_type
      );

      // Convert to array and calculate stats
      const priceHistory: Array<{ date: string; price: number }> = [];
      let highestPrice = -Infinity;
      let lowestPrice = Infinity;

      priceMap.forEach((price, dateStr) => {
        priceHistory.push({ date: dateStr, price });
        if (price > highestPrice) highestPrice = price;
        if (price < lowestPrice) lowestPrice = price;
      });

      // Sort by date
      priceHistory.sort((a, b) => a.date.localeCompare(b.date));

      // Get entry and current prices
      const entryPrice = prediction.asset_entry_price
        ? parseFloat(prediction.asset_entry_price)
        : priceHistory[0]?.price || null;

      const currentPrice =
        priceHistory.length > 0
          ? priceHistory[priceHistory.length - 1].price
          : null;

      const priceChangePercent =
        entryPrice && currentPrice
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : null;

      // 6. Build context
      const context: VerificationContext = {
        prediction: {
          id: prediction.id,
          asset: prediction.asset,
          assetType: prediction.asset_type || "stock",
          sentiment: prediction.sentiment || "neutral",
          predictionText: prediction.prediction_text || "",
          horizonValue: horizonValue,
          horizonType: horizonType,
          targetPrice: prediction.target_price
            ? parseFloat(prediction.target_price)
            : null,
          conditions,
          confidence,
        },
        video: {
          videoId: prediction.video_id,
          title: videoData?.video_title || "",
          channelName: prediction.channel_name || "",
          postDate: prediction.post_date,
          language: videoData?.language || "en",
        },
        rawTranscript: videoData?.raw_transcript || null,
        prices: {
          entryPrice,
          entryPriceDate: prediction.post_date,
          currentPrice,
          priceHistory,
          priceChangePercent,
        },
        currentHorizon: {
          horizonStart: horizonStart.toISOString().split("T")[0],
          horizonEnd: horizonEnd.toISOString().split("T")[0],
        },
      };

      return context;
    } catch (error) {
      logger.error(`Error gathering context for prediction ${predictionId}`, {
        error,
      });
      return null;
    }
  }

  /**
   * Build the AI prompt for verification
   */
  private buildPrompt(context: VerificationContext): string {
    const { prediction, video, rawTranscript, prices, currentHorizon } =
      context;

    // Format price history (sample if too many points)
    let priceHistoryStr = "";
    const history = prices.priceHistory;
    if (history.length > 0) {
      // Show first, last, and sampled middle points (max 15 entries)
      const sampled: Array<{ date: string; price: number }> = [];
      if (history.length <= 15) {
        sampled.push(...history);
      } else {
        sampled.push(history[0]); // First
        const step = Math.floor(history.length / 13);
        for (let i = step; i < history.length - 1; i += step) {
          sampled.push(history[i]);
        }
        sampled.push(history[history.length - 1]); // Last
      }
      priceHistoryStr = sampled
        .map((p) => `  - ${p.date}: ${p.price}`)
        .join("\n");
    } else {
      priceHistoryStr = "  No price data available";
    }

    // Truncate transcript if too long (keep first and last parts)
    let transcriptContent =
      rawTranscript || "Not available - use prediction text only";
    if (transcriptContent.length > 8000) {
      const firstPart = transcriptContent.slice(0, 4000);
      const lastPart = transcriptContent.slice(-3500);
      transcriptContent = `${firstPart}\n\n[... transcript truncated for length ...]\n\n${lastPart}`;
    }

    const currentDate = new Date().toISOString().split("T")[0];

    return `You are a financial prediction verification expert. Analyze the following prediction and determine if it should be marked as CORRECT, WRONG, or PENDING.

## Prediction Details
- **Asset**: ${prediction.asset} (${prediction.assetType})
- **Finfluencer**: ${video.channelName}
- **Prediction Date**: ${video.postDate}
- **Sentiment**: ${prediction.sentiment}
- **Stated Horizon**: "${prediction.horizonValue}"
- **Target Price**: ${prediction.targetPrice || "Not explicitly specified"}
- **Conditions**: ${prediction.conditions || "None stated"}
- **Confidence Level**: ${prediction.confidence}

## Original Prediction Text
"${prediction.predictionText}"

## Raw Transcript Context
<transcript>
${transcriptContent}
</transcript>

## Price Data
- **Entry Price** (${prices.entryPriceDate}): ${prices.entryPrice || "Unknown"}
- **Current Price**: ${prices.currentPrice || "Unknown"}
- **Price Change**: ${prices.priceChangePercent?.toFixed(2) || "N/A"}%
- **Price History** (${currentHorizon.horizonStart} to ${
      currentHorizon.horizonEnd
    }):
${priceHistoryStr}

## Current Horizon Dates (May Be Wrong!)
- **Horizon Start**: ${currentHorizon.horizonStart}
- **Horizon End**: ${currentHorizon.horizonEnd}

## Current Date
${currentDate}

## Your Analysis Tasks

### 1. VALIDATE HORIZON DATES (CRITICAL!)
Based on the prediction text and transcript, determine the CORRECT horizon dates:
- When did the finfluencer expect this prediction to START materializing?
- When is the DEADLINE for this prediction?
- Are the current horizon dates correct, or do they need fixing?

Examples of horizon interpretation:
- "by end of year" → horizon_end = Dec 31 of that year
- "in the next few months" → horizon_end = 3-4 months from post_date
- "2026" → horizon_start = Jan 1 2026, horizon_end = Dec 31 2026
- "soon" / "yakında" → horizon_end = 1-3 months from post_date
- "long term" / "uzun vadede" → horizon_end = 1-2 years from post_date

### 2. INTERPRET SUCCESS CRITERIA
What price or condition would satisfy this prediction? Consider:
- Explicit target prices mentioned
- Percentage gains/losses implied
- Relative terms ("new ATH", "break resistance", "double", "2x")
- Hedging language ("might", "could", "if X happens")

### 3. EVALUATE OUTCOME
Given the price history and your interpreted horizon, has the prediction:
- **CORRECT**: Met the success criteria within the (corrected) horizon
- **WRONG**: Corrected horizon has passed without meeting criteria
- **PENDING**: Corrected horizon hasn't passed yet

### 4. IDENTIFY FLAGS
- Was conditional language used? If so, were conditions met?
- Was hedging language used that affects evaluation?

### 5. VALIDATE PREDICTION TEXT (CRITICAL!)
The current prediction_text may be paraphrased or modified. Find the EXACT original quote from the transcript where the finfluencer made this prediction about ${
      prediction.asset
    }. 
- The prediction text should be EXACTLY what the finfluencer said, word for word
- Include enough context to understand the prediction (1-3 sentences)
- If the transcript is in Turkish, keep it in Turkish - do NOT translate
- If you cannot find the exact quote, set correctedPredictionText to null

### 6. VALIDATE ASSET TYPE
Check if the asset type "${prediction.assetType}" is correct. Valid types:
- "stock" - Individual company stocks (AAPL, MSFT, etc.)
- "crypto" - Cryptocurrencies (BTC, ETH, etc.)
- "forex" - Currency pairs (EURUSD, USDTRY, etc.)
- "commodity" - Gold, Silver, Oil, etc.
- "index" - Stock indices (SPX, NASDAQ, BIST100, etc.)
- "etf" - Exchange traded funds

If the asset type is wrong, provide the correct one.

### 7. VALIDATE HORIZON VALUE (CRITICAL!)
The current horizon_value is: "${prediction.horizonValue}"

Check if this represents a VALID FUTURE TIME HORIZON. Invalid horizon values include:
- Past references: "yılbaşından bugüne" (from new year until today), "geçen hafta" (last week)
- Conditional phrases: "Sonrasında dünyadaki tansiyona bakarak" (looking at world tension afterwards)
- Non-time references: "borsa açılışında" (at market open), "fırsatçı bakış" (opportunistic view)
- Vague expressions: "bir süre sonra", "ileride", "yakında" without specific timeframe

A VALID horizon value should be:
- Specific timeframe: "1 month", "3 months", "1 year", "2025 year-end", "Q2 2025"
- Relative future: "next week", "next month", "by end of year"
- Turkish equivalents: "1 ay", "3 ay", "1 yıl", "yıl sonuna kadar"

If the horizon value is INVALID, provide a corrected value based on:
1. Context from the transcript (what timeframe did the finfluencer imply?)
2. If no clear timeframe, default to "3 months" (3 ay)

## Response Format (JSON only, no markdown code blocks)
{
  "status": "correct|wrong|pending",
  "confidence": "low|medium|high",
  "reasoning": "Brief explanation of your decision",
  "correctedHorizon": {
    "horizonStart": "YYYY-MM-DD",
    "horizonEnd": "YYYY-MM-DD",
    "wasCorrected": true|false,
    "correctionReason": "Why dates were changed" or null
  },
  "interpretation": {
    "interpretedTarget": "Description of target criteria",
    "successCriteria": "What would make this correct"
  },
  "evidence": {
    "targetMet": true|false|null,
    "targetMetDate": "YYYY-MM-DD" or null,
    "highestPrice": number or null,
    "lowestPrice": number or null
  },
  "flags": {
    "hedgedLanguage": true|false,
    "conditionalPrediction": true|false,
    "conditionsMet": true|false|null
  },
  "corrections": {
    "correctedPredictionText": "Exact quote from transcript" or null,
    "predictionTextWasCorrected": true|false,
    "predictionTextCorrectionReason": "Why text was corrected" or null,
    "correctedAssetType": "stock|crypto|forex|commodity|index|etf" or null,
    "assetTypeWasCorrected": true|false,
    "assetTypeCorrectionReason": "Why asset type was corrected" or null,
    "correctedHorizonValue": "Corrected horizon expression" or null,
    "horizonValueWasCorrected": true|false,
    "horizonValueCorrectionReason": "Why horizon value was corrected" or null
  }
}`;
  }

  /**
   * Parse AI response into structured result
   */
  private parseResponse(
    content: string,
    context: VerificationContext
  ): AIVerificationResult | null {
    try {
      // Try to extract JSON from response
      let jsonStr = content.trim();

      // Remove markdown code blocks if present
      if (jsonStr.startsWith("```")) {
        const lines = jsonStr.split("\n");
        lines.shift(); // Remove first ```json line
        if (lines[lines.length - 1] === "```") {
          lines.pop();
        }
        jsonStr = lines.join("\n");
      }

      // Find JSON object in response
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error("No JSON found in AI response", {
          content: content.slice(0, 500),
        });
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate required fields
      if (
        !parsed.status ||
        !["correct", "wrong", "pending"].includes(parsed.status)
      ) {
        logger.error("Invalid status in AI response", { parsed });
        return null;
      }

      // Build result with defaults for missing fields
      const result: AIVerificationResult = {
        status: parsed.status as "correct" | "wrong" | "pending",
        confidence: parsed.confidence || "medium",
        reasoning: parsed.reasoning || "No reasoning provided",
        correctedHorizon: {
          horizonStart:
            parsed.correctedHorizon?.horizonStart ||
            context.currentHorizon.horizonStart,
          horizonEnd:
            parsed.correctedHorizon?.horizonEnd ||
            context.currentHorizon.horizonEnd,
          wasCorrected: parsed.correctedHorizon?.wasCorrected || false,
          correctionReason: parsed.correctedHorizon?.correctionReason || null,
        },
        interpretation: {
          interpretedTarget:
            parsed.interpretation?.interpretedTarget || "Unknown",
          successCriteria: parsed.interpretation?.successCriteria || "Unknown",
        },
        evidence: {
          targetMet: parsed.evidence?.targetMet ?? null,
          targetMetDate: parsed.evidence?.targetMetDate || null,
          highestPrice: parsed.evidence?.highestPrice ?? null,
          lowestPrice: parsed.evidence?.lowestPrice ?? null,
        },
        flags: {
          hedgedLanguage: parsed.flags?.hedgedLanguage || false,
          conditionalPrediction: parsed.flags?.conditionalPrediction || false,
          conditionsMet: parsed.flags?.conditionsMet ?? null,
        },
        corrections: {
          correctedPredictionText:
            parsed.corrections?.correctedPredictionText || null,
          predictionTextWasCorrected:
            parsed.corrections?.predictionTextWasCorrected || false,
          predictionTextCorrectionReason:
            parsed.corrections?.predictionTextCorrectionReason || null,
          correctedAssetType: parsed.corrections?.correctedAssetType || null,
          assetTypeWasCorrected:
            parsed.corrections?.assetTypeWasCorrected || false,
          assetTypeCorrectionReason:
            parsed.corrections?.assetTypeCorrectionReason || null,
          correctedHorizonValue:
            parsed.corrections?.correctedHorizonValue || null,
          horizonValueWasCorrected:
            parsed.corrections?.horizonValueWasCorrected || false,
          horizonValueCorrectionReason:
            parsed.corrections?.horizonValueCorrectionReason || null,
        },
      };

      return result;
    } catch (error) {
      logger.error("Failed to parse AI verification response", {
        error,
        content: content.slice(0, 500),
      });
      return null;
    }
  }

  /**
   * Main verification method
   */
  async verifyPrediction(
    context: VerificationContext
  ): Promise<AIVerificationResult | null> {
    try {
      const prompt = this.buildPrompt(context);

      logger.info(`🤖 AI Verification for ${context.prediction.asset}`, {
        predictionId: context.prediction.id,
        hasTranscript: !!context.rawTranscript,
        pricePoints: context.prices.priceHistory.length,
      });

      // Use the same sendRequest method as globalAIAnalyzer
      const response = await (globalAIAnalyzer as any).sendRequest(prompt);
      const content = response?.choices?.[0]?.message?.content;

      if (!content) {
        logger.error("Empty response from AI", {
          predictionId: context.prediction.id,
        });
        return null;
      }

      const result = this.parseResponse(content, context);

      if (result) {
        logger.info(`✅ AI Verification complete: ${result.status}`, {
          predictionId: context.prediction.id,
          status: result.status,
          confidence: result.confidence,
          horizonCorrected: result.correctedHorizon.wasCorrected,
        });
      }

      return result;
    } catch (error) {
      logger.error("AI verification failed", {
        predictionId: context.prediction.id,
        error,
      });
      return null;
    }
  }

  /**
   * Apply verification result to database
   */
  async applyVerificationResult(
    predictionId: string,
    result: AIVerificationResult,
    priceHistory: Array<{ date: string; price: number }>
  ): Promise<boolean> {
    try {
      // Determine actual_price based on result
      let actualPrice: number | null = null;

      if (result.evidence.targetMetDate && priceHistory.length > 0) {
        // Find price at target met date
        const priceEntry = priceHistory.find(
          (p) => p.date === result.evidence.targetMetDate
        );
        actualPrice = priceEntry?.price || null;
      }

      if (!actualPrice && priceHistory.length > 0) {
        // Use last available price
        actualPrice = priceHistory[priceHistory.length - 1].price;
      }

      const updateData: Record<string, any> = {
        // Core verification result
        status: result.status,
        updated_at: new Date().toISOString(),

        // Horizon dates (always update with AI's version, corrected or not)
        horizon_start_date: result.correctedHorizon.horizonStart,
        horizon_end_date: result.correctedHorizon.horizonEnd,

        // AI Audit Trail
        ai_verification_at: new Date().toISOString(),
        ai_verification_status: result.status,
        ai_verification_confidence: result.confidence,
        ai_verification_reasoning: result.reasoning,
      };

      // Handle resolution fields
      if (result.status !== "pending") {
        // If resolved (correct/wrong), set resolution fields
        updateData.resolved_at = new Date().toISOString();
        if (actualPrice) {
          updateData.actual_price = String(actualPrice);
        }
      } else {
        // If pending, CLEAR resolution fields (in case it was previously resolved)
        updateData.resolved_at = null;
        updateData.actual_price = null;
      }

      // Only set correction fields if horizon was corrected
      if (result.correctedHorizon.wasCorrected) {
        updateData.ai_corrected_horizon_start =
          result.correctedHorizon.horizonStart;
        updateData.ai_corrected_horizon_end =
          result.correctedHorizon.horizonEnd;
        updateData.ai_horizon_correction_reason =
          result.correctedHorizon.correctionReason;
      }

      // Apply prediction text correction (exact quote from transcript)
      if (
        result.corrections.predictionTextWasCorrected &&
        result.corrections.correctedPredictionText
      ) {
        updateData.prediction_text = result.corrections.correctedPredictionText;
        logger.info(`📝 Corrected prediction text for ${predictionId}`, {
          reason: result.corrections.predictionTextCorrectionReason,
        });
      }

      // Apply asset type correction
      if (
        result.corrections.assetTypeWasCorrected &&
        result.corrections.correctedAssetType
      ) {
        updateData.asset_type = result.corrections.correctedAssetType;
        logger.info(`🏷️ Corrected asset type for ${predictionId}`, {
          newType: result.corrections.correctedAssetType,
          reason: result.corrections.assetTypeCorrectionReason,
        });
      }

      // Apply horizon value correction (e.g., "yılbaşından bugüne" -> "3 months")
      if (
        result.corrections.horizonValueWasCorrected &&
        result.corrections.correctedHorizonValue
      ) {
        updateData.horizon_value = result.corrections.correctedHorizonValue;
        logger.info(`📅 Corrected horizon value for ${predictionId}`, {
          newValue: result.corrections.correctedHorizonValue,
          reason: result.corrections.horizonValueCorrectionReason,
        });
      }

      const { error } = await supabaseService.supabase
        .from("combined_predictions")
        .update(updateData)
        .eq("id", predictionId);

      if (error) {
        logger.error("Failed to apply verification result", {
          predictionId,
          error,
        });
        return false;
      }

      logger.info(`💾 Applied verification result`, {
        predictionId,
        status: result.status,
        horizonCorrected: result.correctedHorizon.wasCorrected,
        textCorrected: result.corrections.predictionTextWasCorrected,
        assetTypeCorrected: result.corrections.assetTypeWasCorrected,
        horizonValueCorrected: result.corrections.horizonValueWasCorrected,
      });

      return true;
    } catch (error) {
      logger.error("Error applying verification result", {
        predictionId,
        error,
      });
      return false;
    }
  }

  /**
   * Full verification workflow: gather context, verify, and apply result
   */
  async verifyAndApply(predictionId: string): Promise<{
    success: boolean;
    result: AIVerificationResult | null;
    error?: string;
  }> {
    // 1. Gather context
    const context = await this.gatherContext(predictionId);
    if (!context) {
      return {
        success: false,
        result: null,
        error: "Failed to gather context",
      };
    }

    // 2. Run AI verification
    const result = await this.verifyPrediction(context);
    if (!result) {
      return { success: false, result: null, error: "AI verification failed" };
    }

    // 3. Apply result to database
    const applied = await this.applyVerificationResult(
      predictionId,
      result,
      context.prices.priceHistory
    );

    if (!applied) {
      return {
        success: false,
        result,
        error: "Failed to apply result to database",
      };
    }

    return { success: true, result };
  }
}

// Export singleton instance
export const aiVerificationService = new AIVerificationService();
