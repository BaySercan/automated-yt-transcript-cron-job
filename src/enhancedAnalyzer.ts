import axios from "axios";
import { config } from "./config";
import { AIAnalysisResult, Prediction, AIModification } from "./types";
import { OpenRouterError, AnalysisError } from "./errors";
import {
  logger,
  retryWithBackoff,
  detectLanguage,
  sanitizeText,
} from "./utils";

/**
 * Global Language-Agnostic AI Analyzer
 * Uses video's default language as primary analysis language
 * Focuses on universal financial concepts across all languages
 */
export class GlobalAIAnalyzer {
  private readonly analysisPrompt: string;

  constructor() {
    this.analysisPrompt = `You are an Expert Multilingual Financial Analyst & Data-Extraction AI. Your ONLY mission is to extract explicit financial/economic predictions from YouTube video transcripts and return them in the required JSON schema. Do NOT infer, guess, or add external information.

====================================================================
CORE LOGIC
====================================================================

1. PRIMARY LANGUAGE
   - Use video metadata defaultLanguage/defaultAudioLanguage as the primary language.
   - Only use content-based detection if metadata is missing or wrong.
   - All textual fields (summary, prediction_text, reason) MUST be in this language.
   - language field must be a valid ISO-639-1 code.

2. FINANCIAL CONTENT VALIDATION
   A transcript is considered financial ONLY IF:
   - Length ≥ 200–300 characters
   - Discusses markets, investments, assets, or economics
   - Includes analysis, direction, or financial commentary

   If financial content exists but no explicit predictions → return predictions: [].

   If NOT financial → return predictions: [] and a summary explaining why.

3. ALLOWED ASSET CLASSES (STRICT)
   You MUST extract predictions ONLY for these 5 asset classes:

   A. Stocks → MUST resolve to international ticker symbols (AAPL, TSLA, NVDA, etc.)
   B. Indices → SPX, NDX, BIST100, DAX, FTSE100, etc.
   C. Commodities → Gold, Silver, Oil (Brent/WTI), Natural Gas
   D. Crypto → BTC, ETH, SOL, etc.
   E. FX pairs → USD/JPY, EUR/USD, GBP/USD, USD/TRY, etc.

   If the asset does NOT belong to these classes → IGNORE (do not extract).

   Resolve all asset references:
   - "Nasdaq" → NDX
   - "S&P", "Amerikan borsası" → SPX
   - "Altın" → Gold
   - “Dolar/TL”, "dolar kuru" → USD/TRY
   - Company names → ticker (Apple → AAPL)

   If unable to resolve a valid ticker symbol → ignore prediction.

4. WHAT COUNTS AS A PREDICTION
   Must include ALL of:
   - A target asset from the allowed list
   - A directional/future statement (up/down/increase/decrease/etc.)
   - OR a target price
   - OR a future time horizon

   If these are missing → NOT a prediction.

====================================================================
PREDICTION EXTRACTION RULESET
====================================================================

1. SENTIMENT
   bullish  → positive direction or increase expected  
   bearish → negative direction or fall expected  
   neutral → future-oriented but no direction

2. TARGET PRICE
   - Must be numeric (integer or float)
   - Convert formats like “13.500” to 13500
   - If it is obviously a transcription error → correct and document in ai_modifications
   - If no target price explicitly stated → null

3. NECESSARY CONDITIONS
   Extract ONLY if explicitly stated (“must hold above 50k”, “if inflation drops”).
   If none → null.

4. HORIZON RULE (CRITICAL UPDATE)
   If an exact date is provided → type = "exact"
   If it is referring to month → type = "month"
   If a quarter → type = "quarter"
   If end of year → type = "end_of_year"

   FOR ALL OTHER CASES (Vague, Relative, Complex, or Unclear):
   → Set type = "unknown"
   → Set value = THE EXACT PHRASE from the transcript.

   Examples of "unknown" horizons:
   - "yakında" (soon)
   - "önümüzdeki süreçte" (in the coming period)
   - "kısa vadeli" (short term)
   - "orta-uzun vade" (medium-long term)
   - "next few weeks"
   - "in the coming months"
   - "seçimden sonra" (after the election)

   DO NOT try to convert these to dates. Just extract the text exactly as is.

5. CONFIDENCE LEVEL
   high     → strong, definite, highly certain language  
   medium   → typical confident prediction without explicit certainty  
   low      → speculative (“might”, “could”, “belki”, “olabilir”)

====================================================================
AI MODIFICATIONS RULE
====================================================================

ai_modifications MUST be used ONLY when:
- A transcription formatting issue is corrected
- A numeric format is normalized
- A clear transcription error is fixed

Each entry MUST include:
- field
- original_value (string)
- corrected_value (typed)
- reason

If no modifications → return an empty array [].

====================================================================
FINAL JSON FORMAT (RETURN EXACTLY THIS SHAPE)
====================================================================

You MUST return ONLY one JSON object with NO text outside it:

{
  "channel_id": "<string or null>",
  "channel_name": "<string or null>",
  "video_id": "<string or null>",
  "video_title": "<string or null>",
  "post_date": "<YYYY-MM-DD or null>",
  "language": "<ISO code>",
  "transcript_summary": "<string in detected language>",
  "predictions": [
    {
      "asset": "<Ticker or asset name from allowed classes>",
      "asset_type": "<stock | index | commodity | crypto | fx>",
      "sentiment": "<bullish | bearish | neutral>",
      "prediction_text": "<string in detected language>",
      "necessary_conditions_for_prediction": "<string or null>",
      "prediction_date": "<YYYY-MM-DD>",
      "horizon": {
        "type": "<exact | month | quarter | end_of_year | unknown>",
        "value": "<string>"
      },
      "target_price": <number or null>,
      "confidence": "<low | medium | high>"
    }
  ],
  "ai_modifications": [
    {
      "field": "<string>",
      "original_value": "<string>",
      "corrected_value": <value>,
      "reason": "<string>"
    }
  ]
}

STRICT RULE: Do NOT output ANYTHING except the JSON object.
STRICT RULE: Do NOT invent predictions, dates, assets, tickers, or prices.
STRICT RULE: Do NOT include assets outside the five allowed categories.
STRICT RULE: Do NOT produce a prediction unless the transcript explicitly makes one.

Use this prompt EXACTLY as provided, and follow all instructions to the letter.`;
  }
  /**
   * Analyze transcript with global language-agnostic approach
   */
  async analyzeTranscript(
    transcript: string,
    videoMetadata: {
      videoId: string;
      title: string;
      channelId: string;
      channelName: string;
      publishedAt: string;
      defaultLanguage?: string;
      defaultAudioLanguage?: string;
    }
  ): Promise<AIAnalysisResult> {
    if (!transcript || transcript.trim().length === 0) {
      throw new AnalysisError("Transcript is empty");
    }

    // Enhanced validation
    if (transcript.length < 200) {
      logger.warn(
        `Transcript too short for analysis: ${transcript.length} characters`
      );
      return this.createFallbackResult(
        videoMetadata,
        "unknown",
        "Transcript too short for analysis"
      );
    }

    try {
      // PRIMARY: Use video's default language from metadata
      const primaryLanguage = this.getPrimaryLanguage(videoMetadata);

      // SECONDARY: Content-based detection as fallback
      const detectedLanguage = detectLanguage(transcript);

      // Use primary language if available, fallback to detected
      const analysisLanguage = primaryLanguage || detectedLanguage;

      logger.info(`Language detection for video ${videoMetadata.videoId}:`, {
        defaultLanguage: videoMetadata.defaultLanguage,
        defaultAudioLanguage: videoMetadata.defaultAudioLanguage,
        detectedLanguage: detectedLanguage,
        finalLanguage: analysisLanguage,
      });

      // Check for financial content using universal patterns
      const hasFinancialContent = this.hasUniversalFinancialContent(
        transcript,
        analysisLanguage
      );

      if (!hasFinancialContent) {
        logger.info(
          `No financial content detected for video ${videoMetadata.videoId} (${analysisLanguage}), marking as out of subject`
        );
        return this.createOutOfSubjectResult(videoMetadata, analysisLanguage);
      }

      // Enhance prompt based on primary video language
      const enhancedPrompt = this.enhancePromptForLanguage(
        this.analysisPrompt,
        analysisLanguage,
        !!primaryLanguage
      );
      const fullPrompt = `${enhancedPrompt}

--- VIDEO METADATA ---
Video ID: ${videoMetadata.videoId}
Title: ${videoMetadata.title}
Channel: ${videoMetadata.channelName}
Published: ${videoMetadata.publishedAt}
Default Language: ${videoMetadata.defaultLanguage || "unknown"}
Default Audio Language: ${videoMetadata.defaultAudioLanguage || "unknown"}
--- END METADATA ---

--- VIDEO TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---`;

      // Send to OpenRouter with enhanced error handling
      const response = await retryWithBackoff(
        async () => {
          return this.sendRequest(fullPrompt);
        },
        3,
        2000
      );

      // Enhanced response validation
      const content = this.extractResponseContent(response);

      if (!content) {
        logger.warn("No API response content, creating fallback result");
        return this.createFallbackResult(
          videoMetadata,
          analysisLanguage,
          "No API response content"
        );
      }

      // Parse and validate response
      const analysisResult = this.parseAnalysisResponse(
        content,
        videoMetadata,
        analysisLanguage
      );

      // Enhanced post-processing
      const finalResult = this.enhanceAnalysisResult(
        analysisResult,
        transcript,
        analysisLanguage
      );

      logger.info(
        `Successfully analyzed transcript for video ${videoMetadata.videoId}`,
        {
          primaryLanguage: primaryLanguage,
          detectedLanguage: detectedLanguage,
          finalLanguage: finalResult.language,
          predictionsFound: finalResult.predictions.length,
          hasFinancialContent: hasFinancialContent,
          contentType: hasFinancialContent ? "financial" : "non-financial",
        }
      );

      return finalResult;
    } catch (error) {
      logger.error(
        `Error analyzing transcript for video ${videoMetadata.videoId}`,
        {
          error: (error as Error).message,
          transcriptLength: transcript.length,
        }
      );

      return this.createFallbackResult(
        videoMetadata,
        detectLanguage(transcript),
        (error as Error).message
      );
    }
  }

  /**
   * Get primary language from video metadata
   */
  private getPrimaryLanguage(videoMetadata: {
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  }): string | null {
    // Priority order: defaultAudioLanguage > defaultLanguage
    const primary =
      videoMetadata.defaultAudioLanguage || videoMetadata.defaultLanguage;

    if (primary) {
      // Normalize language codes
      const normalized = primary.toLowerCase().split("-")[0]; // Remove region code
      logger.debug(
        `Using video metadata language: ${primary} -> ${normalized}`
      );
      return normalized;
    }

    return null;
  }

  /**
   * Universal financial content detection
   */
  private hasUniversalFinancialContent(
    transcript: string,
    language: string
  ): boolean {
    const lowerTranscript = transcript.toLowerCase();

    // Universal financial patterns (work across languages)
    const universalFinancialPatterns = [
      // Market-related
      "market",
      "stock",
      "investment",
      "trading",
      "price",
      "trend",
      "analysis",
      "prediction",
      "forecast",
      "bullish",
      "bearish",
      "buy",
      "sell",
      "hold",
      "economy",
      "economic",
      "finance",
      "financial",
      "currency",
      "crypto",
      "gold",
      "silver",
      "oil",
      "inflation",
      "interest",
      "rate",
      "recession",
      "growth",
      "decline",
      "gain",
      "loss",
      "profit",
      "portfolio",

      // Investment terms
      "asset",
      "bond",
      "etf",
      "fund",
      "index",
      "derivative",
      "hedge",
      "dividend",
      "earnings",
      "revenue",
      "valuation",
      "multiple",

      // Financial actions
      "invest",
      "trade",
      "speculate",
      "hedge",
      "diversify",
      "allocate",
      "short",
      "long",
      "leverage",
      "margin",
      "derivative",
    ];

    // Language-specific financial terms
    const languageSpecificTerms =
      this.getLanguageSpecificFinancialTerms(language);

    // Count financial content
    const universalCount = universalFinancialPatterns.filter((pattern) =>
      lowerTranscript.includes(pattern)
    ).length;

    const specificCount = languageSpecificTerms.filter((term) =>
      lowerTranscript.includes(term)
    ).length;

    // Content quality checks
    const isLongEnough = transcript.length >= 200;
    const hasSubstantialContent = transcript.length >= 500;

    // Prediction language patterns (universal)
    const predictionPatterns = [
      "will",
      "going to",
      "expected",
      "projected",
      "forecast",
      "prediction",
      "target",
      "goal",
      "aim",
      "estimate",
      "anticipate",
      "foresee",
    ];
    const hasPredictionLanguage = predictionPatterns.some((pattern) =>
      lowerTranscript.includes(pattern)
    );

    const totalFinancialTerms = universalCount + specificCount;
    const hasStrongFinancialContent = totalFinancialTerms >= 2;
    const hasModerateFinancialContent =
      totalFinancialTerms >= 1 && hasSubstantialContent;
    const hasPredictionBasedContent =
      hasPredictionLanguage &&
      (totalFinancialTerms >= 1 || hasSubstantialContent);

    const hasFinancialContent =
      hasStrongFinancialContent ||
      hasModerateFinancialContent ||
      hasPredictionBasedContent;

    logger.debug(`Universal financial content check:`, {
      language,
      transcriptLength: transcript.length,
      universalCount,
      specificCount,
      totalFinancialTerms,
      hasPredictionLanguage,
      hasSubstantialContent,
      hasStrongFinancialContent,
      hasModerateFinancialContent,
      hasPredictionBasedContent,
      hasFinancialContent,
    });

    return isLongEnough && hasFinancialContent;
  }

  /**
   * Get language-specific financial terms
   */
  private getLanguageSpecificFinancialTerms(language: string): string[] {
    const terms: { [key: string]: string[] } = {
      tr: [
        "borsa",
        "yatırım",
        "hisse",
        "endeks",
        "dolar",
        "euro",
        "avro",
        "altın",
        "gümüş",
        "petrol",
        "enflasyon",
        "faiz",
        "yükseliş",
        "düşüş",
        "piyasa",
        "tahmin",
        "analiz",
        "strateji",
        "portföy",
        "gelir",
        "kar",
        "zarar",
      ],
      es: [
        "bolsa",
        "inversión",
        "acciones",
        "índice",
        "dólar",
        "euro",
        "oro",
        "plata",
        "petróleo",
        "inflación",
        "interés",
        "alza",
        "bajada",
        "mercado",
        "predicción",
        "análisis",
        "estrategia",
        "cartera",
        "ingreso",
        "ganancia",
        "pérdida",
      ],
      de: [
        "börse",
        "investition",
        "aktien",
        "index",
        "dollar",
        "euro",
        "gold",
        "silber",
        "öl",
        "inflation",
        "zins",
        "steigen",
        "fallen",
        "markt",
        "vorhersage",
        "analyse",
        "strategie",
        "portfolio",
        "einkommen",
        "gewinn",
        "verlust",
      ],
      zh: [
        "股市",
        "投资",
        "股票",
        "指数",
        "美元",
        "欧元",
        "黄金",
        "白银",
        "石油",
        "通胀",
        "利率",
        "上涨",
        "下跌",
        "市场",
        "预测",
        "分析",
        "策略",
        "投资组合",
        "收入",
        "利润",
        "损失",
      ],
      ja: [
        "株式",
        "投資",
        "株価",
        "指数",
        "ドル",
        "ユーロ",
        "金",
        "銀",
        "石油",
        "インフレ",
        "金利",
        "上昇",
        "下落",
        "市場",
        "予測",
        "分析",
        "戦略",
        "ポートフォリオ",
        "収入",
        "利益",
        "損失",
      ],
      ar: [
        "البورصة",
        "الاستثمار",
        "الأسهم",
        "المؤشر",
        "الدولار",
        "اليورو",
        "الذهب",
        "الفضة",
        "النفط",
        "التضخم",
        "سعر الفائدة",
        "ارتفاع",
        "انخفاض",
        "السوق",
        "التنبؤ",
        "التحليل",
        "الاستراتيجية",
        "المحفظة",
        "الدخل",
        "الربح",
        "الخسارة",
      ],
    };

    return terms[language] || [];
  }

  /**
   * Enhance prompt based on detected video language
   */
  private enhancePromptForLanguage(
    basePrompt: string,
    analysisLanguage: string,
    isVideoDefault?: boolean
  ): string {
    const languageNames: { [key: string]: string } = {
      en: "English",
      es: "Spanish",
      de: "German",
      fr: "French",
      it: "Italian",
      pt: "Portuguese",
      zh: "Chinese",
      ja: "Japanese",
      ko: "Korean",
      ar: "Arabic",
      tr: "Turkish",
      ru: "Russian",
      hi: "Hindi",
    };

    const languageName =
      languageNames[analysisLanguage] || analysisLanguage.toUpperCase();

    return (
      basePrompt +
      `

**MULTILINGUAL ANALYSIS ENHANCEMENT:**
- PRIMARY LANGUAGE: ${analysisLanguage} (${languageName})
- SOURCE: Video metadata language is ${isVideoDefault ? "PRIMARY" : "FALLBACK"}
- Focus on ${languageName} financial terminology and expressions
- Extract predictions using ${languageName} financial language patterns
- Ensure transcript summary is in ${languageName}
- Adapt analysis approach to ${languageName} linguistic patterns`
    );
  }

  /**
   * Extract content from API response with multiple fallbacks
   */
  private extractResponseContent(response: any): string | null {
    // Multiple fallback strategies
    const fallbacks = [
      () => response?.choices?.[0]?.message?.content,
      () => response?.data?.choices?.[0]?.message?.content,
      () => response?.output?.choices?.[0]?.message?.content,
      () => (typeof response === "string" ? response : null),
    ];

    for (const fallback of fallbacks) {
      try {
        const content = fallback();
        if (
          content &&
          typeof content === "string" &&
          content.trim().length > 0
        ) {
          return content;
        }
      } catch (error) {
        // Continue to next fallback
      }
    }

    return null;
  }

  /**
   * Enhanced analysis result processing
   */
  private enhanceAnalysisResult(
    result: AIAnalysisResult,
    transcript: string,
    language: string
  ): AIAnalysisResult {
    // If no predictions but has financial content, create a more descriptive result
    if (
      result.predictions.length === 0 &&
      this.hasUniversalFinancialContent(transcript, language)
    ) {
      return {
        ...result,
        transcript_summary:
          result.transcript_summary ||
          `Financial analysis content detected in ${language}. Content discusses market trends, investments, or economic developments but no specific predictions were extracted.`,
        language: language,
      };
    }

    return result;
  }

  /**
   * Create result for out-of-subject content
   */
  private createOutOfSubjectResult(
    videoMetadata: {
      videoId: string;
      title: string;
      channelId: string;
      channelName: string;
      publishedAt: string;
    },
    language: string
  ): AIAnalysisResult {
    return {
      channel_id: videoMetadata.channelId,
      channel_name: sanitizeText(videoMetadata.channelName),
      video_id: videoMetadata.videoId,
      video_title: sanitizeText(videoMetadata.title),
      post_date: videoMetadata.publishedAt.split("T")[0]!,
      language: language,
      transcript_summary:
        "Content does not appear to be financial or economic in nature",
      predictions: [],
      ai_modifications: [],
    };
  }

  // Reuse existing utility methods...
  private async sendRequest(prompt: string): Promise<any> {
    const requestBody = {
      model: [config.openrouterModel, config.openrouterModel2],
      messages: [
        {
          role: "system",
          content:
            "You are a multilingual financial analyst AI. Respond with ONLY valid JSON. No markdown, no explanations.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: config.openrouterTemperature,
      max_tokens: config.openrouterMaxTokens,
      response_format: { type: "json_object" },
    };

    const response = await axios.post(
      `${config.openrouterBaseUrl}/chat/completions`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${config.openrouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://finfluencer-tracker.com",
          "X-Title": "Finfluencer Tracker",
        },
        timeout: config.requestTimeout,
      }
    );

    if (response.status !== 200) {
      throw new OpenRouterError(
        `OpenRouter API returned status ${response.status}`
      );
    }

    return response.data;
  }

  private parseAnalysisResponse(
    content: string,
    videoMetadata: any,
    detectedLanguage: string
  ): AIAnalysisResult {
    const cleanedContent = this.cleanJsonResponse(content);
    const parsed = JSON.parse(cleanedContent);

    return {
      channel_id: parsed.channel_id || videoMetadata.channelId,
      channel_name: sanitizeText(
        parsed.channel_name || videoMetadata.channelName
      ),
      video_id: parsed.video_id || videoMetadata.videoId,
      video_title: sanitizeText(parsed.video_title || videoMetadata.title),
      post_date: parsed.post_date || videoMetadata.publishedAt.split("T")[0],
      language: parsed.language || detectedLanguage,
      transcript_summary: sanitizeText(parsed.transcript_summary || ""),
      predictions: this.validatePredictions(parsed.predictions || []),
      ai_modifications: this.validateModifications(
        parsed.ai_modifications || []
      ),
    };
  }

  private cleanJsonResponse(content: string): string {
    let cleaned = content.trim();
    cleaned = cleaned.replace(/```json\s*/g, "").replace(/```\s*$/g, "");
    cleaned = cleaned.replace(/```\s*/g, "").replace(/```\s*$/g, "");
    cleaned = cleaned.replace(
      /^(Here is|Here's|The result is|Result:|Output:)\s*/i,
      ""
    );
    cleaned = cleaned.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
    cleaned = cleaned.replace(/\\"/g, '"');
    return cleaned.trim();
  }

  private validatePredictions(predictions: any[]): Prediction[] {
    if (!Array.isArray(predictions)) return [];
    return predictions
      .filter((pred) => pred && typeof pred === "object")
      .map((pred) => ({
        asset: sanitizeText(String(pred.asset || "")).toUpperCase(),
        sentiment: this.validateSentiment(pred.sentiment),
        prediction_text: sanitizeText(String(pred.prediction_text || "")),
        prediction_date: this.validateDate(pred.prediction_date),
        horizon: this.validateHorizon(pred.horizon),
        target_price: this.validateTargetPrice(pred.target_price),
        confidence: this.validateConfidence(pred.confidence),
      }))
      .filter((pred) => pred.asset && pred.prediction_text);
  }

  private validateModifications(modifications: any[]): AIModification[] {
    if (!Array.isArray(modifications)) return [];
    return modifications
      .filter((mod) => mod && typeof mod === "object")
      .map((mod) => ({
        field: sanitizeText(String(mod.field || "")),
        original_value: mod.original_value,
        corrected_value: mod.corrected_value,
        reason: sanitizeText(String(mod.reason || "")),
      }))
      .filter((mod) => mod.field && mod.reason);
  }

  private validateSentiment(sentiment: any): "bullish" | "bearish" | "neutral" {
    const valid = ["bullish", "bearish", "neutral"];
    const normalized = String(sentiment || "").toLowerCase();
    return valid.includes(normalized) ? (normalized as any) : "neutral";
  }

  private validateDate(date: any): string {
    if (!date) return new Date().toISOString().split("T")[0]!;
    const dateStr = String(date);
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    return dateRegex.test(dateStr)
      ? dateStr
      : new Date().toISOString().split("T")[0]!;
  }

  private validateHorizon(horizon: any): {
    type: "exact" | "end_of_year" | "quarter" | "month" | "custom";
    value: string;
  } {
    if (!horizon || typeof horizon !== "object") {
      return { type: "custom", value: "unknown" };
    }
    const validTypes: (
      | "exact"
      | "end_of_year"
      | "quarter"
      | "month"
      | "custom"
    )[] = ["exact", "end_of_year", "quarter", "month", "custom"];
    const type = validTypes.includes(String(horizon.type || "") as any)
      ? (String(horizon.type || "") as any)
      : "custom";
    return { type, value: sanitizeText(String(horizon.value || "unknown")) };
  }

  private validateTargetPrice(price: any): number | null {
    if (price === null || price === undefined) return null;
    const num = Number(price);
    return !isNaN(num) && num > 0 ? num : null;
  }

  private validateConfidence(confidence: any): "low" | "medium" | "high" {
    const valid = ["low", "medium", "high"];
    const normalized = String(confidence || "").toLowerCase();
    return valid.includes(normalized) ? (normalized as any) : "medium";
  }

  private createFallbackResult(
    videoMetadata: any,
    detectedLanguage: string,
    errorMessage?: string
  ): AIAnalysisResult {
    return {
      channel_id: videoMetadata.channelId,
      channel_name: sanitizeText(videoMetadata.channelName),
      video_id: videoMetadata.videoId,
      video_title: sanitizeText(videoMetadata.title),
      post_date: videoMetadata.publishedAt.split("T")[0]!,
      language: detectedLanguage,
      transcript_summary: errorMessage
        ? `Analysis failed: ${errorMessage}`
        : "Analysis completed - no structured data extracted",
      predictions: [],
      ai_modifications: [],
    };
  }
}

export const globalAIAnalyzer = new GlobalAIAnalyzer();
