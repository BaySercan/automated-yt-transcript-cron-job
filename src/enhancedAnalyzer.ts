import axios from 'axios';
import { config } from './config';
import { AIAnalysisResult, Prediction, AIModification } from './types';
import { OpenRouterError, AnalysisError } from './errors';
import { logger, retryWithBackoff, detectLanguage, sanitizeText } from './utils';

/**
 * Global Language-Agnostic AI Analyzer
 * Uses video's default language as primary analysis language
 * Focuses on universal financial concepts across all languages
 */
export class GlobalAIAnalyzer {
  private readonly analysisPrompt: string;

  constructor() {
    this.analysisPrompt = `You are an Expert Financial Analyst and Data Extraction AI specialized in multilingual financial content analysis. Your task is to analyze video transcripts in ANY LANGUAGE and extract financial/economic predictions using universal financial concepts.

**CORE PRINCIPLES:**

1. **Primary Language Source:** Use the video's DEFAULT LANGUAGE (from metadata) as your primary language for analysis
2. **Language-Agnostic Detection:** Focus on universal financial concepts, not language-specific keywords
3. **Global Applicability:** Work with any language - English, Spanish, German, French, Chinese, Japanese, Arabic, etc.

**UNIVERSAL FINANCIAL CONCEPTS (Language-Agnostic):**

**Financial Markets & Assets:**
- Stock market discussions (bourse, bolsa, börse, 股市, 株式, الأسهم)
- Investment discussions (investment, inversión, investition, 投資)
- Price movements (up/down, rise/fall, increase/decrease)
- Market analysis and trends
- Economic indicators and forecasts

**Financial Prediction Patterns:**
- Future tense language (will, shall, going to, expected, predicted)
- Price targets and levels
- Time-based predictions (tomorrow, next month, year-end)
- Market sentiment (bullish/bearish equivalents across languages)
- Economic policy impacts

**Financial Terminology (Universal):**
- Currency mentions (USD, EUR, GBP, JPY, CNY, etc.)
- Commodities (gold, oil, silver, agricultural products)
- Economic events (earnings, GDP, inflation, interest rates)
- Investment vehicles (stocks, bonds, ETFs, crypto, funds)

**ANALYSIS APPROACH:**

1. **Language Detection Priority:**
   - PRIMARY: Use video metadata language (defaultLanguage/defaultAudioLanguage)
   - SECONDARY: Use content-based language detection
   - FOCUS: Adapt analysis approach to the detected language

2. **Universal Content Validation:**
   - Look for financial market discussions
   - Identify investment advice or analysis
   - Detect economic predictions or forecasts
   - Recognize price discussions and trend analysis

3. **Content Quality Assessment:**
   - Minimum transcript length: 200 characters
   - Must contain financial/economic discussion
   - Should discuss markets, investments, or economic trends
   - Consider speaker expertise and topic focus

**LANGUAGE-SPECIFIC ENHANCEMENTS:**

**For English Content:**
- Look for: "stock", "market", "investment", "trading", "price", "trend", "analysis", "prediction", "forecast"
- Prediction patterns: "will go up/down", "expected to", "projected", "target price"

**For Spanish Content:** 
- Look for: "bolsa", "mercado", "inversión", "comercio", "precio", "tendencia", "análisis", "predicción"
- Prediction patterns: "va a subir/bajar", "se espera", "proyectado", "precio objetivo"

**For German Content:**
- Look for: "börse", "markt", "investition", "handel", "preis", "trend", "analyse", "vorhersage"
- Prediction patterns: "wird steigen/fallen", "erwartet", "projiziert", "zielpreis"

**For Chinese Content:**
- Look for: 股市, 投资, 市场, 价格, 趋势, 分析, 预测
- Prediction patterns: 将上涨/下跌, 预期, 目标价格

**For Japanese Content:**
- Look for: 株式, 投資, 市場, 価格, トレンド, 分析, 予測
- Prediction patterns: 上がる/下がる, 予想, 目標価格

**For Arabic Content:**
- Look for: البورصة, الاستثمار, السوق, السعر, الاتجاه, التحليل, التنبؤ
- Prediction patterns: سيرتفع/سينخفض, متوقع, السعر المستهدف

**For Turkish Content:**
- Look for: "borsa", "yatırım", "hisse", "endeks", "dolar", "euro", "avro", "altın", "gümüş", "petrol", "enflasyon", "faiz", "yükseliş", "düşüş", "piyasa"
- Prediction patterns: "yükselecek", "düşecek", "olacak", "gidecek", "artacak", "azalacak", "bekleniyor", "hedef fiyat"

**VALIDATION CRITERIA:**
- Video must be substantial length (usually 300+ characters)
- Must contain financial/economic discussion in ANY language
- Should mention markets, investments, or economic trends
- Use language-specific financial terminology appropriately
- Only mark as out-of-subject for clearly non-financial content (cooking, entertainment, gaming, etc.)

**OUTPUT REQUIREMENTS:**
- Return structured JSON with financial predictions
- Language field should reflect the video's actual content language
- If content IS financial but no specific predictions found → Return empty predictions array with appropriate summary
- If content is NOT financial → Mark appropriately
- Transcript summary should capture the main financial focus in the detected language

Core Constraints & Rules

    Strict JSON Format: The final output MUST be a single, valid JSON object that strictly adheres to the structure provided below. Do not include any introductory text, concluding remarks, or explanations outside of the JSON block.

    No Extraneous Content: You MUST NOT add any information, predictions, or analyses that are not directly and explicitly mentioned in the provided transcript. Your role is extraction and structuring, not inference or analysis beyond what is written.

    Complete Prediction Capture: You MUST strive to identify and include every single distinct financial prediction made for an asset, market, or economic indicator within the transcript in the predictions array.

    Language Preservation: The values for all fields (including transcript_summary, prediction_text, reason, etc.) MUST be in the detected language of the transcript (e.g., if the transcript is in Turkish, the summary must be in Turkish). The language code in the language field should reflect this (e.g., tr, en).

    Data Integrity: If a piece of required information is genuinely missing or not stated in the transcript (e.g., no specific target price, no confidence level, no prediction date), you MUST use null for that field's value, or an empty array ([]) where appropriate (e.g., ai_modifications).

Field-Specific Instructions

Top-Level Fields

    channel_id, channel_name, video_id, video_title, post_date: Populate these directly from the provided metadata. Use "null" if the metadata is missing.

    language: Detect the primary language of the transcript and use its standard two-letter ISO 639-1 code (e.g., en, tr, de).

    transcript_summary: Provide a concise, objective, and accurate summary of the video's main financial/economic focus and conclusion.(Use sentences as much as you want, as long as you want to summarize the video well, it can be a longer summary)

predictions Array Fields

    asset: The specific asset, market, or economic factor being predicted (e.g., "BTC", "AAPL", "Gold", "Inflation", "USD/JPY").

    sentiment: Categorize the prediction's stance as one of the following exact strings: "bullish" | "bearish" | "neutral".

    prediction_text: A direct quote or a close paraphrase of the sentence(s) containing the prediction.

    necessary_conditions_for_prediction: Extract any explicitly mentioned prerequisites, technical levels, or market events that must occur for the prediction to be valid (e.g., "BTC must stay above $50k support"). Use "null" if no conditions are stated.

    prediction_date: The date the prediction was published/spoken. Use the post_date unless the speaker explicitly refers to a different date (e.g., a date from a previous video). Format as YYYY-MM-DD.

    horizon:

        type: Must be one of: "exact" (a specific date), "end_of_year", "quarter", "month", or "custom" (e.g., "in the next 6 months," "next year").

        value: The specific value corresponding to the type (e.g., 2025-12-31 for exact, Q3 for quarter, December for month, end of the year for end_of_year, or the custom phrase).

    target_price: Extract the numerical value of the target price. Crucially, this must be a numeric type (integer or float), not a string. Use null if no numerical target is given (e.g., only "it will go higher" is mentioned).

    confidence: Categorize the speaker's stated level of certainty: "low" | "medium" | "high". Use "medium" if no explicit confidence level is mentioned, but a firm prediction is made. Use "low" if the prediction is highly speculative or only a possibility.

ai_modifications Array Fields

    This array is for corrections/modifications based on clear transcription errors or formatting adjustments.

    Crucial Example: If a target price is transcribed as a string like "13.500" but, based on the asset and context, it is highly probable that this is a common transcription error for a high-value asset like Bitcoin, you must correct it to the numeric value (e.g., 135000) and document the change here.

    field: The field name being corrected (e.g., "target_price").

    original_value: The value as it appeared in the raw transcript or initial extraction (must be a string).

    corrected_value: The final, corrected value (must be the correct data type: number, string, etc.).

    reason: A brief, clear explanation for the modification.

    If no modifications are necessary, this array MUST be empty: [].

IMPORTANT: You MUST respond with ONLY valid JSON. No markdown, no explanations, no extra text.

### JSON Output Format:
{
  "channel_id": "<YouTube channel ID or null>",
  "channel_name": "<YouTube channel name or null>",
  "video_id": "<YouTube video ID or null>",
  "video_title": "<Title or null>",
  "post_date": "<Post date in YYYY-MM-DD or null>",
  "language": "<Detected language code (e.g. en, tr)>",
  "transcript_summary": "<Concise summary of the video>",
  "predictions": [
    {
      "asset": "<e.g. BTC, AAPL, Gold, etc. use international ticker symbols or names>",
      "sentiment": "<bullish | bearish | neutral>",
      "prediction_text": "<Quote or paraphrase of the prediction>",
      "necessary_conditions_for_prediction": "<Conditions that must be met for the prediction to hold (if any, else null)>",
      "prediction_date": "<Prediction made date in YYYY-MM-DD>",
      "horizon": {
        "type": "<exact | end_of_year | quarter | month | custom>",
        "value": "<e.g. 2025-12-31, Q3, December, end of the year>"
      },
      "target_price": <Numeric value if any, else null>,
      "confidence": "<low | medium | high>"
    }
  ],
  "ai_modifications": 
  <If any predictions were modified or corrected according to AI review, list them here, below is an example. If none, return an empty array.>
  [
    {
      "field": "target_price",
      "original_value": "13.500",
      "corrected_value": 135000,
      "reason": "Likely transcription error — BTC cannot be priced at 13.500."
    },
    {...}
  ]

`;

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
      throw new AnalysisError('Transcript is empty');
    }

    // Enhanced validation
    if (transcript.length < 200) {
      logger.warn(`Transcript too short for analysis: ${transcript.length} characters`);
      return this.createFallbackResult(videoMetadata, 'unknown', 'Transcript too short for analysis');
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
        finalLanguage: analysisLanguage
      });

      // Check for financial content using universal patterns
      const hasFinancialContent = this.hasUniversalFinancialContent(transcript, analysisLanguage);
      
      if (!hasFinancialContent) {
        logger.info(`No financial content detected for video ${videoMetadata.videoId} (${analysisLanguage}), marking as out of subject`);
        return this.createOutOfSubjectResult(videoMetadata, analysisLanguage);
      }

      // Enhance prompt based on primary video language
      const enhancedPrompt = this.enhancePromptForLanguage(this.analysisPrompt, analysisLanguage, !!primaryLanguage);
      const fullPrompt = `${enhancedPrompt}

--- VIDEO METADATA ---
Video ID: ${videoMetadata.videoId}
Title: ${videoMetadata.title}
Channel: ${videoMetadata.channelName}
Published: ${videoMetadata.publishedAt}
Default Language: ${videoMetadata.defaultLanguage || 'unknown'}
Default Audio Language: ${videoMetadata.defaultAudioLanguage || 'unknown'}
--- END METADATA ---

--- VIDEO TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---`;

      // Send to OpenRouter with enhanced error handling
      const response = await retryWithBackoff(async () => {
        return this.sendRequest(fullPrompt);
      }, 3, 2000);

      // Enhanced response validation
      const content = this.extractResponseContent(response);
      
      if (!content) {
        logger.warn('No API response content, creating fallback result');
        return this.createFallbackResult(videoMetadata, analysisLanguage, 'No API response content');
      }

      // Parse and validate response
      const analysisResult = this.parseAnalysisResponse(content, videoMetadata, analysisLanguage);
      
      // Enhanced post-processing
      const finalResult = this.enhanceAnalysisResult(analysisResult, transcript, analysisLanguage);

      logger.info(`Successfully analyzed transcript for video ${videoMetadata.videoId}`, {
        primaryLanguage: primaryLanguage,
        detectedLanguage: detectedLanguage,
        finalLanguage: finalResult.language,
        predictionsFound: finalResult.predictions.length,
        hasFinancialContent: hasFinancialContent,
        contentType: hasFinancialContent ? 'financial' : 'non-financial'
      });

      return finalResult;

    } catch (error) {
      logger.error(`Error analyzing transcript for video ${videoMetadata.videoId}`, { 
        error: (error as Error).message,
        transcriptLength: transcript.length
      });
      
      return this.createFallbackResult(videoMetadata, detectLanguage(transcript), (error as Error).message);
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
    const primary = videoMetadata.defaultAudioLanguage || videoMetadata.defaultLanguage;
    
    if (primary) {
      // Normalize language codes
      const normalized = primary.toLowerCase().split('-')[0]; // Remove region code
      logger.debug(`Using video metadata language: ${primary} -> ${normalized}`);
      return normalized;
    }
    
    return null;
  }

  /**
   * Universal financial content detection
   */
  private hasUniversalFinancialContent(transcript: string, language: string): boolean {
    const lowerTranscript = transcript.toLowerCase();
    
    // Universal financial patterns (work across languages)
    const universalFinancialPatterns = [
      // Market-related
      'market', 'stock', 'investment', 'trading', 'price', 'trend', 'analysis',
      'prediction', 'forecast', 'bullish', 'bearish', 'buy', 'sell', 'hold',
      'economy', 'economic', 'finance', 'financial', 'currency', 'crypto',
      'gold', 'silver', 'oil', 'inflation', 'interest', 'rate', 'recession',
      'growth', 'decline', 'gain', 'loss', 'profit', 'portfolio',
      
      // Investment terms
      'asset', 'bond', 'etf', 'fund', 'index', 'derivative', 'hedge',
      'dividend', 'earnings', 'revenue', 'valuation', 'multiple',
      
      // Financial actions
      'invest', 'trade', 'speculate', 'hedge', 'diversify', 'allocate',
      'short', 'long', 'leverage', 'margin', 'derivative'
    ];

    // Language-specific financial terms
    const languageSpecificTerms = this.getLanguageSpecificFinancialTerms(language);

    // Count financial content
    const universalCount = universalFinancialPatterns.filter(pattern => 
      lowerTranscript.includes(pattern)
    ).length;

    const specificCount = languageSpecificTerms.filter(term => 
      lowerTranscript.includes(term)
    ).length;

    // Content quality checks
    const isLongEnough = transcript.length >= 200;
    const hasSubstantialContent = transcript.length >= 500;
    
    // Prediction language patterns (universal)
    const predictionPatterns = [
      'will', 'going to', 'expected', 'projected', 'forecast', 'prediction',
      'target', 'goal', 'aim', 'estimate', 'anticipate', 'foresee'
    ];
    const hasPredictionLanguage = predictionPatterns.some(pattern => 
      lowerTranscript.includes(pattern)
    );

    const totalFinancialTerms = universalCount + specificCount;
    const hasStrongFinancialContent = totalFinancialTerms >= 2;
    const hasModerateFinancialContent = totalFinancialTerms >= 1 && hasSubstantialContent;
    const hasPredictionBasedContent = hasPredictionLanguage && (totalFinancialTerms >= 1 || hasSubstantialContent);
    
    const hasFinancialContent = hasStrongFinancialContent || hasModerateFinancialContent || hasPredictionBasedContent;

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
      hasFinancialContent
    });

    return isLongEnough && hasFinancialContent;
  }

  /**
   * Get language-specific financial terms
   */
  private getLanguageSpecificFinancialTerms(language: string): string[] {
    const terms: { [key: string]: string[] } = {
      'tr': [
        'borsa', 'yatırım', 'hisse', 'endeks', 'dolar', 'euro', 'avro', 'altın',
        'gümüş', 'petrol', 'enflasyon', 'faiz', 'yükseliş', 'düşüş', 'piyasa',
        'tahmin', 'analiz', 'strateji', 'portföy', 'gelir', 'kar', 'zarar'
      ],
      'es': [
        'bolsa', 'inversión', 'acciones', 'índice', 'dólar', 'euro', 'oro',
        'plata', 'petróleo', 'inflación', 'interés', 'alza', 'bajada', 'mercado',
        'predicción', 'análisis', 'estrategia', 'cartera', 'ingreso', 'ganancia', 'pérdida'
      ],
      'de': [
        'börse', 'investition', 'aktien', 'index', 'dollar', 'euro', 'gold',
        'silber', 'öl', 'inflation', 'zins', 'steigen', 'fallen', 'markt',
        'vorhersage', 'analyse', 'strategie', 'portfolio', 'einkommen', 'gewinn', 'verlust'
      ],
      'zh': [
        '股市', '投资', '股票', '指数', '美元', '欧元', '黄金',
        '白银', '石油', '通胀', '利率', '上涨', '下跌', '市场',
        '预测', '分析', '策略', '投资组合', '收入', '利润', '损失'
      ],
      'ja': [
        '株式', '投資', '株価', '指数', 'ドル', 'ユーロ', '金',
        '銀', '石油', 'インフレ', '金利', '上昇', '下落', '市場',
        '予測', '分析', '戦略', 'ポートフォリオ', '収入', '利益', '損失'
      ],
      'ar': [
        'البورصة', 'الاستثمار', 'الأسهم', 'المؤشر', 'الدولار', 'اليورو', 'الذهب',
        'الفضة', 'النفط', 'التضخم', 'سعر الفائدة', 'ارتفاع', 'انخفاض', 'السوق',
        'التنبؤ', 'التحليل', 'الاستراتيجية', 'المحفظة', 'الدخل', 'الربح', 'الخسارة'
      ]
    };

    return terms[language] || [];
  }

  /**
   * Enhance prompt based on detected video language
   */
  private enhancePromptForLanguage(basePrompt: string, analysisLanguage: string, isVideoDefault?: boolean): string {
    const languageNames: { [key: string]: string } = {
      'en': 'English',
      'es': 'Spanish', 
      'de': 'German',
      'fr': 'French',
      'it': 'Italian',
      'pt': 'Portuguese',
      'zh': 'Chinese',
      'ja': 'Japanese',
      'ko': 'Korean',
      'ar': 'Arabic',
      'tr': 'Turkish',
      'ru': 'Russian',
      'hi': 'Hindi'
    };

    const languageName = languageNames[analysisLanguage] || analysisLanguage.toUpperCase();
    
    return basePrompt + `

**MULTILINGUAL ANALYSIS ENHANCEMENT:**
- PRIMARY LANGUAGE: ${analysisLanguage} (${languageName})
- SOURCE: Video metadata language is ${isVideoDefault ? 'PRIMARY' : 'FALLBACK'}
- Focus on ${languageName} financial terminology and expressions
- Extract predictions using ${languageName} financial language patterns
- Ensure transcript summary is in ${languageName}
- Adapt analysis approach to ${languageName} linguistic patterns`;
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
      () => typeof response === 'string' ? response : null
    ];

    for (const fallback of fallbacks) {
      try {
        const content = fallback();
        if (content && typeof content === 'string' && content.trim().length > 0) {
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
    if (result.predictions.length === 0 && this.hasUniversalFinancialContent(transcript, language)) {
      return {
        ...result,
        transcript_summary: result.transcript_summary || 
          `Financial analysis content detected in ${language}. Content discusses market trends, investments, or economic developments but no specific predictions were extracted.`,
        language: language
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
      post_date: videoMetadata.publishedAt.split('T')[0]!,
      language: language,
      transcript_summary: 'Content does not appear to be financial or economic in nature',
      predictions: [],
      ai_modifications: []
    };
  }

  // Reuse existing utility methods...
  private async sendRequest(prompt: string): Promise<any> {
    const requestBody = {
      model: config.openrouterModel,
      messages: [
        {
          role: 'system',
          content: 'You are a multilingual financial analyst AI. Respond with ONLY valid JSON. No markdown, no explanations.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: config.openrouterTemperature,
      max_tokens: config.openrouterMaxTokens,
      response_format: { type: 'json_object' }
    };

    const response = await axios.post(
      `${config.openrouterBaseUrl}/chat/completions`,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${config.openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://finfluencer-tracker.com',
          'X-Title': 'Finfluencer Tracker'
        },
        timeout: config.requestTimeout
      }
    );

    if (response.status !== 200) {
      throw new OpenRouterError(`OpenRouter API returned status ${response.status}`);
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
      channel_name: sanitizeText(parsed.channel_name || videoMetadata.channelName),
      video_id: parsed.video_id || videoMetadata.videoId,
      video_title: sanitizeText(parsed.video_title || videoMetadata.title),
      post_date: parsed.post_date || videoMetadata.publishedAt.split('T')[0],
      language: parsed.language || detectedLanguage,
      transcript_summary: sanitizeText(parsed.transcript_summary || ''),
      predictions: this.validatePredictions(parsed.predictions || []),
      ai_modifications: this.validateModifications(parsed.ai_modifications || [])
    };
  }

  private cleanJsonResponse(content: string): string {
    let cleaned = content.trim();
    cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
    cleaned = cleaned.replace(/```\s*/g, '').replace(/```\s*$/g, '');
    cleaned = cleaned.replace(/^(Here is|Here's|The result is|Result:|Output:)\s*/i, '');
    cleaned = cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    cleaned = cleaned.replace(/\\"/g, '"');
    return cleaned.trim();
  }

  private validatePredictions(predictions: any[]): Prediction[] {
    if (!Array.isArray(predictions)) return [];
    return predictions
      .filter(pred => pred && typeof pred === 'object')
      .map(pred => ({
        asset: sanitizeText(String(pred.asset || '')).toUpperCase(),
        sentiment: this.validateSentiment(pred.sentiment),
        prediction_text: sanitizeText(String(pred.prediction_text || '')),
        prediction_date: this.validateDate(pred.prediction_date),
        horizon: this.validateHorizon(pred.horizon),
        target_price: this.validateTargetPrice(pred.target_price),
        confidence: this.validateConfidence(pred.confidence)
      }))
      .filter(pred => pred.asset && pred.prediction_text);
  }

  private validateModifications(modifications: any[]): AIModification[] {
    if (!Array.isArray(modifications)) return [];
    return modifications
      .filter(mod => mod && typeof mod === 'object')
      .map(mod => ({
        field: sanitizeText(String(mod.field || '')),
        original_value: mod.original_value,
        corrected_value: mod.corrected_value,
        reason: sanitizeText(String(mod.reason || ''))
      }))
      .filter(mod => mod.field && mod.reason);
  }

  private validateSentiment(sentiment: any): 'bullish' | 'bearish' | 'neutral' {
    const valid = ['bullish', 'bearish', 'neutral'];
    const normalized = String(sentiment || '').toLowerCase();
    return valid.includes(normalized) ? normalized as any : 'neutral';
  }

  private validateDate(date: any): string {
    if (!date) return new Date().toISOString().split('T')[0]!;
    const dateStr = String(date);
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    return dateRegex.test(dateStr) ? dateStr : new Date().toISOString().split('T')[0]!;
  }

  private validateHorizon(horizon: any): { type: 'exact' | 'end_of_year' | 'quarter' | 'month' | 'custom'; value: string } {
    if (!horizon || typeof horizon !== 'object') {
      return { type: 'custom', value: 'unknown' };
    }
    const validTypes: ('exact' | 'end_of_year' | 'quarter' | 'month' | 'custom')[] = ['exact', 'end_of_year', 'quarter', 'month', 'custom'];
    const type = validTypes.includes(String(horizon.type || '') as any) 
      ? (String(horizon.type || '') as any) 
      : 'custom';
    return { type, value: sanitizeText(String(horizon.value || 'unknown')) };
  }

  private validateTargetPrice(price: any): number | null {
    if (price === null || price === undefined) return null;
    const num = Number(price);
    return !isNaN(num) && num > 0 ? num : null;
  }

  private validateConfidence(confidence: any): 'low' | 'medium' | 'high' {
    const valid = ['low', 'medium', 'high'];
    const normalized = String(confidence || '').toLowerCase();
    return valid.includes(normalized) ? normalized as any : 'medium';
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
      post_date: videoMetadata.publishedAt.split('T')[0]!,
      language: detectedLanguage,
      transcript_summary: errorMessage ? `Analysis failed: ${errorMessage}` : 'Analysis completed - no structured data extracted',
      predictions: [],
      ai_modifications: []
    };
  }
}

export const globalAIAnalyzer = new GlobalAIAnalyzer();
