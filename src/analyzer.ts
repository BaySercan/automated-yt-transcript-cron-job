import axios from 'axios';
import { config } from './config';
import { AIAnalysisResult, Prediction, AIModification } from './types';
import { OpenRouterError, AnalysisError } from './errors';
import { logger, retryWithBackoff, detectLanguage, sanitizeText } from './utils';

export class AIAnalyzer {
  private readonly analysisPrompt: string;

  constructor() {
    this.analysisPrompt = `You are an Expert Financial Analyst and Data Extraction AI. Your sole task is to meticulously analyze a provided YouTube video transcript and its metadata (Channel ID, Name, Video ID, Title, Post Date) to extract all explicitly stated financial or economical predictions and format the results into a single, strict JSON object.

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
      "asset": "<e.g. BTC, AAPL, Gold>",
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
}`;
  }

  // Test OpenRouter connection
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.sendRequest('Hello, respond with valid JSON.');
      
      if (!response || !response.choices || response.choices.length === 0) {
        throw new OpenRouterError('Invalid response from OpenRouter API');
      }

      logger.info('OpenRouter API connection successful');
      return true;
    } catch (error) {
      logger.error('OpenRouter API connection test failed', { error });
      throw error;
    }
  }

  // Analyze transcript and extract financial predictions
  async analyzeTranscript(
    transcript: string,
    videoMetadata: {
      videoId: string;
      title: string;
      channelId: string;
      channelName: string;
      publishedAt: string;
    }
  ): Promise<AIAnalysisResult> {
    if (!transcript || transcript.trim().length === 0) {
      throw new AnalysisError('Transcript is empty');
    }

    try {
      // Detect language
      const language = detectLanguage(transcript);
      
      // Prepare the full prompt
      const fullPrompt = `${this.analysisPrompt}

--- VIDEO TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---

--- VIDEO METADATA ---
Video ID: ${videoMetadata.videoId}
Title: ${videoMetadata.title}
Channel: ${videoMetadata.channelName}
Published: ${videoMetadata.publishedAt}
--- END METADATA ---`;

      // Send to OpenRouter with enhanced error handling
      const response = await retryWithBackoff(async () => {
        return this.sendRequest(fullPrompt);
      }, 3, 2000);

      logger.info('OpenRouter API response received', {
        hasResponse: !!response,
        responseType: typeof response,
        hasChoices: !!response?.choices,
        choicesLength: response?.choices?.length || 0,
        firstChoice: response?.choices?.[0] ? 'exists' : 'missing',
        model: config.openrouterModel
      });

      // Enhanced response validation with multiple fallbacks
      let content = response?.choices?.[0]?.message?.content;
      
      // Fallback 1: Check response.data
      if (!content && response?.data?.choices?.[0]?.message?.content) {
        logger.info('Found content in response.data format');
        content = response.data.choices[0].message.content;
      }
      
      // Fallback 2: Check for alternative structures
      if (!content && response?.output?.choices?.[0]?.message?.content) {
        logger.info('Found content in output.choices format');
        content = response.output.choices[0].message.content;
      }
      
      // Fallback 3: Check if it's already a direct content string
      if (!content && typeof response === 'string') {
        logger.info('Response is directly a string');
        content = response;
      }

      if (!content) {
        logger.error('No content found in OpenRouter API response after all fallbacks', {
          fullResponse: JSON.stringify(response, null, 2),
          availableKeys: Object.keys(response || {})
        });
        
        // Instead of throwing, create a fallback result
        logger.warn('Creating fallback result due to no API content');
        return this.createFallbackResult(videoMetadata, language, 'No API response content');
      }

      // Parse JSON response with enhanced error recovery
      const analysisResult = this.parseAnalysisResponse(content, videoMetadata, language);
      
      logger.info(`Successfully analyzed transcript for video ${videoMetadata.videoId}`, {
        predictionsFound: analysisResult.predictions.length,
        modifications: analysisResult.ai_modifications.length,
        contentLength: content.length
      });

      return analysisResult;
    } catch (error) {
      logger.error(`Error analyzing transcript for video ${videoMetadata.videoId}`, { 
        error: (error as Error).message,
        errorType: (error as Error).name,
        stack: (error as Error).stack 
      });
      
      // Return fallback result instead of throwing
      return this.createFallbackResult(videoMetadata, detectLanguage(transcript), (error as Error).message);
    }
  }

  // Send request to OpenRouter API with enhanced debugging
  private async sendRequest(prompt: string): Promise<any> {
    logger.info('Sending request to OpenRouter API', {
      model: config.openrouterModel,
      promptLength: prompt.length,
      temperature: config.openrouterTemperature,
      maxTokens: config.openrouterMaxTokens
    });

    try {
      const requestBody = {
        model: config.openrouterModel,
        messages: [
          {
            role: 'system',
            content: 'You are a financial analyst AI. Respond with ONLY valid JSON. No markdown, no explanations.'
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

      logger.info('OpenRouter API request body', {
        model: requestBody.model,
        temperature: requestBody.temperature,
        max_tokens: requestBody.max_tokens,
        messagesCount: requestBody.messages.length
      });

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

      logger.info('OpenRouter API response status', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.keys(response.headers),
        dataKeys: response.data ? Object.keys(response.data) : 'no data'
      });

      if (response.status !== 200) {
        throw new OpenRouterError(
          `OpenRouter API returned status ${response.status}`,
          { status: response.status, cause: response.data }
        );
      }

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data;
        const message = error.message;
        
        logger.error('OpenRouter API request failed', {
          status,
          message,
          data,
          url: error.config?.url,
          method: error.config?.method
        });
        
        throw new OpenRouterError(
          `OpenRouter API request failed: ${message}`,
          { status, cause: data }
        );
      }
      
      logger.error('Unexpected error in OpenRouter API request', { error: (error as Error).message });
      throw new OpenRouterError(`Unexpected error: ${(error as Error).message}`);
    }
  }

  // Parse and validate analysis response with enhanced error handling
  private parseAnalysisResponse(
    content: string,
    videoMetadata: {
      videoId: string;
      title: string;
      channelId: string;
      channelName: string;
      publishedAt: string;
    },
    detectedLanguage: string
  ): AIAnalysisResult {
    logger.info('Starting JSON response parsing', {
      contentLength: content.length,
      contentPreview: content.substring(0, 200) + '...'
    });

    try {
      // Clean the response
      const cleanedContent = this.cleanJsonResponse(content);
      
      logger.info('JSON content cleaned', {
        originalLength: content.length,
        cleanedLength: cleanedContent.length,
        startsWithBrace: cleanedContent.trim().startsWith('{'),
        endsWithBrace: cleanedContent.trim().endsWith('}')
      });
      
      // Parse JSON with robust fallback strategies
      const parsed = this.robustJsonParse(cleanedContent);
      
      if (!parsed) {
        logger.warn('All JSON parsing strategies failed, creating fallback result');
        return this.createFallbackResult(videoMetadata, detectedLanguage, 'JSON parsing failed');
      }

      // Type assertion for parsed object
      const parsedData = parsed as any;

      logger.info('JSON parsed successfully', {
        keys: Object.keys(parsedData),
        hasPredictions: !!parsedData.predictions,
        predictionsCount: Array.isArray(parsedData.predictions) ? parsedData.predictions.length : 0
      });

      // Validate and normalize the structure
      const result: AIAnalysisResult = {
        channel_id: parsedData.channel_id || videoMetadata.channelId,
        channel_name: sanitizeText(parsedData.channel_name || videoMetadata.channelName),
        video_id: parsedData.video_id || videoMetadata.videoId,
        video_title: sanitizeText(parsedData.video_title || videoMetadata.title),
        post_date: parsedData.post_date || videoMetadata.publishedAt.split('T')[0],
        language: parsedData.language || detectedLanguage,
        transcript_summary: sanitizeText(parsedData.transcript_summary || ''),
        predictions: this.validatePredictions(parsedData.predictions || []),
        ai_modifications: this.validateModifications(parsedData.ai_modifications || [])
      };

      return result;
    } catch (error) {
      logger.error('Error parsing AI response', { 
        error: (error as Error).message,
        content: content.substring(0, 500) + '...'
      });
      
      return this.createFallbackResult(videoMetadata, detectedLanguage, (error as Error).message);
    }
  }

  // Clean JSON response
  private cleanJsonResponse(content: string): string {
    let cleaned = content.trim();
    
    // Remove markdown code blocks
    cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
    cleaned = cleaned.replace(/```\s*/g, '').replace(/```\s*$/g, '');
    
    // Remove common AI response prefixes
    cleaned = cleaned.replace(/^(Here is|Here's|The result is|Result:|Output:|JSON Response:|Response:)\s*/i, '');
    
    // Fix common JSON formatting issues
    cleaned = cleaned.replace(/,\s*}/g, '}'); // Remove trailing commas
    cleaned = cleaned.replace(/,\s*]/g, ']'); // Remove trailing commas in arrays
    
    // Handle escaped quotes
    cleaned = cleaned.replace(/\\"/g, '"');
    
    return cleaned.trim();
  }

  // Robust JSON parsing with multiple fallback strategies
  private robustJsonParse(content: string): any {
    // Strategy 1: Direct parse
    try {
      return JSON.parse(content);
    } catch (error) {
      logger.warn('Direct JSON parsing failed');
    }
    
    // Strategy 2: Try to extract JSON from content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (error) {
        logger.warn('Extracted JSON parsing failed');
      }
    }
    
    // Strategy 3: Try to fix common issues and parse again
    try {
      const fixedContent = this.fixCommonJsonIssues(content);
      return JSON.parse(fixedContent);
    } catch (error) {
      logger.warn('Fixed JSON parsing failed');
    }
    
    return null;
  }

  // Fix common JSON issues
  private fixCommonJsonIssues(content: string): string {
    let fixed = content;
    
    // Fix unquoted keys
    fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    
    // Fix single quotes to double quotes
    fixed = fixed.replace(/'/g, '"');
    
    // Fix trailing commas in objects and arrays
    fixed = fixed.replace(/,\s*}/g, '}');
    fixed = fixed.replace(/,\s*]/g, ']');
    
    return fixed;
  }

  // Create fallback result
  private createFallbackResult(
    videoMetadata: {
      videoId: string;
      title: string;
      channelId: string;
      channelName: string;
      publishedAt: string;
    },
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

  // Validate and normalize predictions
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

  // Validate and normalize modifications
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

  // Validate sentiment value
  private validateSentiment(sentiment: any): 'bullish' | 'bearish' | 'neutral' {
    const valid = ['bullish', 'bearish', 'neutral'];
    const normalized = String(sentiment || '').toLowerCase();
    return valid.includes(normalized) ? normalized as any : 'neutral';
  }

  // Validate date format
  private validateDate(date: any): string {
    if (!date) return new Date().toISOString().split('T')[0]!;
    
    const dateStr = String(date);
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    
    if (dateRegex.test(dateStr)) {
      return dateStr;
    }
    
    return new Date().toISOString().split('T')[0]!;
  }

  // Validate horizon object
  private validateHorizon(horizon: any): { type: 'exact' | 'end_of_year' | 'quarter' | 'month' | 'custom'; value: string } {
    if (!horizon || typeof horizon !== 'object') {
      return { type: 'custom', value: 'unknown' };
    }

    const validTypes: ('exact' | 'end_of_year' | 'quarter' | 'month' | 'custom')[] = ['exact', 'end_of_year', 'quarter', 'month', 'custom'];
    const type = validTypes.includes(String(horizon.type || '') as any) 
      ? (String(horizon.type || '') as any) 
      : 'custom';

    return {
      type,
      value: sanitizeText(String(horizon.value || 'unknown'))
    };
  }

  // Validate target price
  private validateTargetPrice(price: any): number | null {
    if (price === null || price === undefined) return null;
    
    const num = Number(price);
    return !isNaN(num) && num > 0 ? num : null;
  }

  // Validate confidence level
  private validateConfidence(confidence: any): 'low' | 'medium' | 'high' {
    const valid = ['low', 'medium', 'high'];
    const normalized = String(confidence || '').toLowerCase();
    return valid.includes(normalized) ? normalized as any : 'medium';
  }
}

// Export singleton instance
export const aiAnalyzer = new AIAnalyzer();
