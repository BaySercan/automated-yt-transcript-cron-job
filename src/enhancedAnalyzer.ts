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

4. WHAT COUNTS AS A PREDICTION (UNIVERSAL SEMANTIC LOGIC)
   A prediction MUST be a forward-looking statement about FUTURE performance. 
   
   **REQUIRED LOGIC PATTERN:**
   \`[Literal Asset] + [Directional Bias] + [Logical Trigger or Target]\`

   **STRICT EXCLUSIONS (DO NOT EXTRACT):**
   - **Past/Present Facts (Declarative)**: Statements about what happened or current levels (e.g., "The price is 50k", "Earnings were high last week").
   - **Descriptive News**: General reporting without a forecast (e.g., "Nvidia released its new chips").
   - **Vague Commentary**: General market sentiment without a tradeable signal (e.g., "The market is quite volatile lately").
   - **Idiomatic/Metaphorical Use**: If an asset name is used as an idiom, verb, or metaphor in the source language (e.g., "undermining", "the gold standard of X").

   **LITERALITY GUARDRAIL:**
   Only extract if the speaker refers to the literal, tradeable financial instrument in a projective (future) context.

5. HORIZON & TARGETS
   Must include at least one of:
   - A target price
   - OR a future time horizon (even if vague)
   - OR a logical condition ("if breaks level X", "until inflation drops")

====================================================================
PREDICTION EXTRACTION RULESET
====================================================================

1. SENTIMENT
   bullish  → positive direction or increase expected  
   bearish → negative direction or fall expected  
   neutral → future-oriented but no direction

2. TARGET PRICE & CURRENCY DETECTION
   - Must be numeric (integer or float)
   - Convert formats like "13.500" to 13500
   - If it is obviously a transcription error → correct and document in ai_modifications
   - If no target price explicitly stated → null

   **CRITICAL: CURRENCY DETECTION (MULTILINGUAL)**
   - Extract target_price_currency_declared ONLY when currency is explicitly mentioned
   - If NO currency mentioned → return null (use asset's default currency)
   - If MULTIPLE currencies mentioned → pick the most suitable one for the target price

   **LANGUAGE-SPECIFIC CURRENCY MAPPING:**
   - English: "$" → USD, "€" → EUR, "£" → GBP, "dollar" → USD, "euro" → EUR, "pound" → GBP
   - Turkish: "dolar" → USD, "dolar seviyesi" → USD, "dolar bazlı" → USD, "lira" → TRY, "TL" → TRY, "euro" → EUR, "avro" → EUR
   - Spanish: "dólar" → USD, "euro" → EUR, "libra" → GBP
   - German: "Dollar" → USD, "Euro" → EUR, "Pfund" → GBP
   - French: "dollar" → USD, "euro" → EUR, "livre" → GBP

   **TURKISH-SPECIFIC RULES (CRITICAL):**
   - "dolar" ALWAYS means USD (American dollar), NOT Turkish currency
   - "dolar seviyesi" → USD level
   - "dolar bazlı" → USD-based
   - "dolar kuru" → USD exchange rate
   - "lira", "TL", "Türk Lirası" → TRY (Turkish Lira)
   - "euro", "avro" → EUR

   **EXAMPLES:**
   - "300 dolar seviyesine" → target_price: 300, target_price_currency_declared: "USD"
   - "277 dolar seviyesi üzerine" → target_price: 277, target_price_currency_declared: "USD"
   - "217 dolar seviyelerine" → target_price: 217, target_price_currency_declared: "USD"
   - "11.000 lira" → target_price: 11000, target_price_currency_declared: "TRY"
   - "300 TL" → target_price: 300, target_price_currency_declared: "TRY"

   **MULTIPLE CURRENCIES:**
   - If prediction mentions multiple currencies, select the one most relevant to the target price
   - Document ALL detected currencies in extraction_metadata.multiple_currencies_detected
   - Provide reasoning in extraction_metadata.selected_currency_reasoning
   - Set extraction_metadata.currency_detection_confidence based on clarity

3. NECESSARY CONDITIONS
   Extract any logical conditions for the prediction (triggers, stop levels, macroeconomic dependencies).
   These are crucial for analytical depth. Use flags like "if", "until", "only if", "stays above", etc.
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
      "target_price_currency_declared": "<string or null>",
      "confidence": "<low | medium | high>",
      "extraction_metadata": {
        "currency_detection_confidence": "<low | medium | high>",
        "multiple_currencies_detected": ["<currency1>", "<currency2>"],
        "selected_currency_reasoning": "<explanation if multiple detected>"
      }
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

      // Calculate quality scores for each prediction and the video as a whole
      let maxScore = 0;
      const scoresBreakdown: any[] = [];

      finalResult.predictions = finalResult.predictions.map((pred) => {
        const scoreResult = this.calculatePredictionScore(pred);
        const score = scoreResult.total;

        if (score > maxScore) maxScore = score;
        scoresBreakdown.push({
          asset: pred.asset,
          score: score,
          breakdown: scoreResult.breakdown,
        });

        return {
          ...pred,
          quality_score: score,
          quality_breakdown: scoreResult.breakdown,
        };
      });

      finalResult.quality_score = maxScore;
      finalResult.quality_breakdown = {
        max_score: maxScore,
        count: finalResult.predictions.length,
        detailed: scoresBreakdown,
        is_actionable: finalResult.predictions.some(
          (p) => (p.quality_score || 0) >= 40
        ),
      };

      logger.info(
        `Successfully analyzed transcript for video ${videoMetadata.videoId}`,
        {
          primaryLanguage: primaryLanguage,
          detectedLanguage: detectedLanguage,
          finalLanguage: finalResult.language,
          predictionsFound: finalResult.predictions.length,
          hasFinancialContent: hasFinancialContent,
          contentType: hasFinancialContent ? "financial" : "non-financial",
          qualityScore: finalResult.quality_score,
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

    // Build language-specific enhancements
    let languageSpecificEnhancements = `

**MULTILINGUAL ANALYSIS ENHANCEMENT:**
- PRIMARY LANGUAGE: ${analysisLanguage} (${languageName})
- SOURCE: Video metadata language is ${isVideoDefault ? "PRIMARY" : "FALLBACK"}
- Focus on ${languageName} financial terminology and expressions
- Extract predictions using ${languageName} financial language patterns
- Ensure transcript summary is in ${languageName}
- Adapt analysis approach to ${languageName} linguistic patterns`;

    // SPECIAL HANDLING FOR TURKISH FINFLUENCERS
    if (analysisLanguage === "tr") {
      languageSpecificEnhancements += `

**⚠️ SPECIAL RULE FOR TURKISH FINFLUENCERS (CRITICAL):**

Turkish speakers often discuss two different gold products:
1. **XAUUSD** (Ounce Gold / USD) - International commodity market (1 ounce = ~31.1 grams)
   - This is the standard GOLD traded globally
   - Price: ~$2000-2100 per ounce
   - Use this if context suggests international/global market

2. **XAUTRYG** (Gram Gold / Turkish Lira) - Local Turkish gold market
   - Denominated in Turkish Lira (TRY) per gram
   - Price: ~100-300 TRY per gram
   - Use this ONLY if:
     a) Turkish speaker explicitly mentions "gram" OR "gr" OR "g" with price
     b) Price is in Turkish Lira (TRY) range context
     c) Context suggests local Turkish precious metals market

**DECISION RULE:**
- If Turkish speaker says "altın" (gold) WITHOUT gram context → Assume XAUUSD (international)
- If Turkish speaker says "gram altın" OR prices are in 100-300 TRY range → Use XAUTRYG
- If UNCERTAIN → Default to XAUUSD (safer for international coverage)

**EXAMPLE MAPPING:**
- "Altın 2100 dolar" → XAUUSD (gold at 2100 dollars)
- "Gram altın 250 lira" → XAUTRYG (gram gold at 250 lira)
- "Altın çıkabilir 2200'e" → XAUUSD (gold might go to 2200 [dollars])
- "Altın gramı 280 TL'ye çıkacak" → XAUTRYG (gram gold will reach 280 TL)`;
    }

    return basePrompt + languageSpecificEnhancements;
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
    // Build list of models to try (primary first, then fallback)
    const models = [config.openrouterModel, config.openrouterModel2].filter(
      (m) => m && typeof m === "string" && m.trim().length > 0
    );

    if (models.length === 0) {
      throw new OpenRouterError("No valid OpenRouter model configured");
    }

    let lastError: Error | null = null;

    for (let i = 0; i < models.length; i++) {
      const model = models[i]!;
      const isLastModel = i === models.length - 1;

      try {
        logger.debug(
          `🔍 OpenRouter request: model="${model}", prompt_length=${prompt.length}`
        );

        const requestBody = {
          model: model,
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
      } catch (error: any) {
        lastError = error;
        const statusCode = error.response?.status;

        // Log the failure
        if (!isLastModel) {
          logger.warn(
            `⚠️ Model ${model} failed (${
              statusCode || error.message
            }), trying fallback...`
          );
        }

        // If this is the last model, we'll throw after the loop
        if (isLastModel) {
          break;
        }

        // Continue to next model for retriable errors (400, 429, 500, 502, 503, 504)
        const retriableStatusCodes = [400, 429, 500, 502, 503, 504];
        if (statusCode && !retriableStatusCodes.includes(statusCode)) {
          // Non-retriable error (like 401 auth), throw immediately
          throw error;
        }
      }
    }

    // All models failed
    throw lastError || new OpenRouterError("All models failed");
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
        target_price_currency_declared:
          pred.target_price_currency_declared || null,
        necessary_conditions_for_prediction:
          pred.necessary_conditions_for_prediction || null,
        confidence: this.validateConfidence(pred.confidence),
        extraction_metadata: pred.extraction_metadata || null,
      }))
      .filter((pred) => pred.asset && pred.prediction_text)
      .filter((pred) => this.isPredictionActionable(pred));
  }

  /**
   * Calculate prediction quality score (language-agnostic)
   * Used to filter out pure news content without actionable predictions
   */
  private calculatePredictionScore(pred: Prediction): {
    total: number;
    breakdown: Record<string, number>;
  } {
    const breakdown: Record<string, number> = {};
    let total = 0;

    // Directional sentiment is primary indicator (+25)
    if (pred.sentiment === "bullish" || pred.sentiment === "bearish") {
      breakdown.direction = 25;
      total += 25;
    }

    // Any horizon indicates forward-looking (+15)
    if (pred.horizon && pred.horizon.value && pred.horizon.value !== "") {
      breakdown.horizon = 15;
      total += 15;
    }

    // Target price is a bonus, not required (+15)
    if (pred.target_price !== null && pred.target_price !== undefined) {
      breakdown.targetPrice = 15;
      total += 15;
    }

    // Necessary conditions show analytical depth (+10)
    if (pred.necessary_conditions_for_prediction) {
      breakdown.conditions = 10;
      total += 10;
    }

    // Confidence bonus (+5)
    if (pred.confidence === "high" || pred.confidence === "medium") {
      breakdown.confidence = 5;
      total += 5;
    }

    return { total, breakdown };
  }

  /**
   * Check if prediction is actionable (score >= 20)
   * Filters out pure news/commentary without forward-looking statements
   */
  private isPredictionActionable(pred: Prediction): boolean {
    const MIN_SCORE_THRESHOLD = 20;
    const { total, breakdown } = this.calculatePredictionScore(pred);

    if (total < MIN_SCORE_THRESHOLD) {
      logger.debug(
        `Filtering low-quality prediction: ${pred.asset}, score: ${total}`,
        {
          asset: pred.asset,
          score: total,
          breakdown,
          sentiment: pred.sentiment,
          horizon: pred.horizon?.value,
          hasTarget: pred.target_price !== null,
        }
      );
      return false;
    }

    return true;
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

    // Try locale-aware parsing first (handles European and English formats)
    const localeNum = this.parseLocaleNumber(String(price));
    if (localeNum !== null) {
      return localeNum;
    }

    // Fallback to direct Number parsing
    const num = Number(price);
    return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
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

  /**
   * Parse numbers from different locales (European vs English format)
   * Handles ambiguous cases intelligently
   * Examples:
   *   "1.234" → European (1234) or English (1.234)? → assume European if no decimals
   *   "1,234" → English (1234) or European decimal? → assume English if followed by 2 digits
   *   "6,570" → European (6.57) or English (6570)? → assume European (standard in Turkish/DE/FR)
   *   "13.500" → European (13500) or English (13.5)? → assume European (common currency format)
   */
  private parseLocaleNumber(
    value: string,
    transcriptLanguage?: string
  ): number | null {
    if (!value || typeof value !== "string") return null;

    const cleaned = value.trim();
    if (cleaned.length === 0) return null;

    // Try direct parse first
    const directNum = Number(cleaned);
    if (!isNaN(directNum) && isFinite(directNum) && directNum > 0) {
      return directNum;
    }

    // Detect format: does it have separators?
    const hasDot = cleaned.includes(".");
    const hasComma = cleaned.includes(",");

    // No separators - just return as-is
    if (!hasDot && !hasComma) {
      const num = Number(cleaned);
      return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
    }

    // Both separators present: "1.234,56" or "1,234.56"
    if (hasDot && hasComma) {
      const dotIndex = cleaned.lastIndexOf(".");
      const commaIndex = cleaned.lastIndexOf(",");

      if (commaIndex > dotIndex) {
        // European format: "1.234,56" → remove dot, replace comma with dot
        const normalized = cleaned.replace(/\./g, "").replace(",", ".");
        const num = Number(normalized);
        return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
      } else {
        // English format: "1,234.56" → remove comma
        const normalized = cleaned.replace(/,/g, "");
        const num = Number(normalized);
        return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
      }
    }

    // Only dots: could be European thousands ("1.234") or English decimal ("1.234")
    if (hasDot && !hasComma) {
      const parts = cleaned.split(".");
      if (parts.length === 2) {
        // Single dot: ambiguous
        const afterDot = parts[1];

        // If >= 3 digits after dot: likely decimal (European scientific notation)
        if (afterDot.length >= 3) {
          const num = Number(cleaned); // keep as-is
          return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
        }

        // If 1-2 digits after dot AND > 2: likely English decimal
        if (afterDot.length <= 2 && !isNaN(Number(afterDot))) {
          const num = Number(cleaned);
          return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
        }

        // Otherwise: European thousands separator, remove it
        const normalized = cleaned.replace(/\./g, "");
        const num = Number(normalized);
        return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
      } else if (parts.length > 2) {
        // Multiple dots: European thousands ("1.000.000"), remove all
        const normalized = cleaned.replace(/\./g, "");
        const num = Number(normalized);
        return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
      }
    }

    // Only commas: likely European decimal or English thousands
    if (hasComma && !hasDot) {
      const parts = cleaned.split(",");
      if (parts.length === 2) {
        const afterComma = parts[1];

        // If 1-2 digits after comma: European decimal ("6,57")
        if (afterComma.length <= 2) {
          const normalized = cleaned.replace(",", ".");
          const num = Number(normalized);
          return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
        }

        // If > 2 digits: English thousands ("1,000,000" style - multiple commas expected but only one present)
        const normalized = cleaned.replace(/,/g, "");
        const num = Number(normalized);
        return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
      } else if (parts.length > 2) {
        // Multiple commas: English thousands separator, remove all
        const normalized = cleaned.replace(/,/g, "");
        const num = Number(normalized);
        return !isNaN(num) && isFinite(num) && num > 0 ? num : null;
      }
    }

    return null;
  }

  /**
   * Get the current model being used (for tracking purposes)
   * Ensures model name is captured from config or env vars, throws if not configured
   */
  getModelName(): string {
    // Check config first (primary preference)
    if (config.openrouterModel && config.openrouterModel.trim()) {
      return config.openrouterModel.trim();
    }

    // Check config fallback model
    if (config.openrouterModel2 && config.openrouterModel2.trim()) {
      return config.openrouterModel2.trim();
    }

    // Fallback to environment variables directly
    const envModel =
      process.env.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL_2;
    if (envModel && envModel.trim()) {
      logger.warn("Using model from env var (config not available)", {
        model: envModel,
      });
      return envModel.trim();
    }

    // CRITICAL: If truly no model configured, fail loudly
    const errorMsg =
      "⚠️ CRITICAL: No AI model configured! Must set OPENROUTER_MODEL or OPENROUTER_MODEL_2 in .env";
    logger.error(errorMsg, {
      configModel: config.openrouterModel,
      configModel2: config.openrouterModel2,
      envModel: process.env.OPENROUTER_MODEL,
      envModel2: process.env.OPENROUTER_MODEL_2,
    });

    throw new Error(errorMsg); // Fail fast instead of returning placeholder
  }

  /**
   * Verify a reconciliation decision using AI
   * Acts as a "second opinion" on rule-based correct/wrong determinations
   */
  async verifyReconciliationDecision(data: {
    asset: string;
    assetType: string;
    sentiment: string;
    targetPrice: number | null;
    entryPrice: number | null;
    actualPrice: number | null;
    postDate: string;
    horizonStart: string;
    horizonEnd: string;
    horizonValue: string;
    ruleBasedDecision: "correct" | "wrong";
    ruleBasedReasoning: string;
  }): Promise<{
    agrees: boolean;
    finalDecision: "correct" | "wrong" | "inconclusive";
    confidence: "high" | "medium" | "low";
    reasoning: string;
    model: string;
  }> {
    const model = this.getModelName();

    const prompt = `You are a financial prediction verification AI. Your task is to verify whether a rule-based decision about a prediction outcome is correct.

## PREDICTION DATA:
- Asset: ${data.asset} (${data.assetType})
- Sentiment: ${data.sentiment}
- Target Price: ${data.targetPrice ?? "Not specified"}
- Entry Price (at prediction date): ${data.entryPrice ?? "Unknown"}
- Actual Price (during horizon): ${data.actualPrice ?? "Unknown"}
- Prediction Date: ${data.postDate}
- Horizon Period: ${data.horizonValue} (${data.horizonStart} to ${
      data.horizonEnd
    })

## RULE-BASED DECISION:
- Decision: ${data.ruleBasedDecision.toUpperCase()}
- Reasoning: ${data.ruleBasedReasoning}

## YOUR TASK:
Evaluate whether the rule-based decision is correct based on the data provided.

For a prediction to be CORRECT:
- BULLISH sentiment: Price should have increased from entry to actual
- BEARISH sentiment: Price should have decreased from entry to actual
- If target_price specified: Actual price should have reached or passed the target
- Consider the horizon period - only prices within the period matter

For a prediction to be WRONG:
- The opposite of the above conditions

For INCONCLUSIVE:
- Missing critical data (no prices available)
- Ambiguous conditions that can't be determined

## RESPONSE FORMAT (JSON only):
{
  "agrees_with_decision": true/false,
  "final_decision": "correct" | "wrong" | "inconclusive",
  "confidence": "high" | "medium" | "low",
  "reasoning": "Brief explanation of your verification"
}

Respond with ONLY the JSON object, no other text.`;

    try {
      const response = await retryWithBackoff(
        async () => this.sendRequest(prompt),
        2,
        2000
      );

      const content = this.extractResponseContent(response);
      if (!content) {
        return {
          agrees: true,
          finalDecision: data.ruleBasedDecision,
          confidence: "low",
          reasoning: "AI verification failed - using rule-based decision",
          model,
        };
      }

      const cleaned = this.cleanJsonResponse(content);
      const parsed = JSON.parse(cleaned);

      return {
        agrees: parsed.agrees_with_decision ?? true,
        finalDecision:
          this.validateReconciliationDecision(parsed.final_decision) ??
          data.ruleBasedDecision,
        confidence: this.validateConfidence(parsed.confidence),
        reasoning: sanitizeText(parsed.reasoning || "No reasoning provided"),
        model,
      };
    } catch (error) {
      logger.warn("AI reconciliation verification failed", { error });
      return {
        agrees: true,
        finalDecision: data.ruleBasedDecision,
        confidence: "low",
        reasoning: `AI verification error: ${(error as Error).message}`,
        model,
      };
    }
  }

  private validateReconciliationDecision(
    decision: any
  ): "correct" | "wrong" | "inconclusive" {
    const valid = ["correct", "wrong", "inconclusive"];
    const normalized = String(decision || "").toLowerCase();
    return valid.includes(normalized)
      ? (normalized as "correct" | "wrong" | "inconclusive")
      : "inconclusive";
  }
}

export const globalAIAnalyzer = new GlobalAIAnalyzer();
