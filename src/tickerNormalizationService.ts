import axios from 'axios';
import { config } from './config';
import { logger } from './utils';
import tickerMapping from './tickerMapping.json';
import BistTickers from '../Exchange_And_Tickers/BIST-Tickers.json';
import UsTickers from '../Exchange_And_Tickers/US-Tickers.json';

/**
 * Ticker Normalization Service
 * Maps asset names to standardized ticker symbols using:
 * 1. Curated mapping for known assets
 * 2. AI fallback for unknowns (with suggested_ticker output)
 */
export class TickerNormalizationService {
  private readonly mapping: Record<string, string> = tickerMapping;

  /**
   * Normalize asset name to standard ticker
   * Priority: exact match → AI inference
   */
  async normalizeTicker(assetName: string, options: { useAI?: boolean; context?: string } = {}): Promise<{ ticker: string; source: 'mapping' | 'ai' | 'fallback'; confidence?: number; market?: string }> {
    try {
      if (!assetName || typeof assetName !== 'string') {
        return { ticker: 'UNKNOWN', source: 'fallback' };
      }

      const normalized = assetName.trim().toUpperCase();

      // 1. Check curated mapping (exact match)
      if (this.mapping[normalized]) {
        return {
          ticker: this.mapping[normalized],
          source: 'mapping',
          confidence: 1.0
        };
      }

      // 2. Check curated mapping (case-insensitive partial match)
      for (const [key, value] of Object.entries(this.mapping)) {
        if (key.toUpperCase().includes(normalized) || normalized.includes(key.toUpperCase())) {
          return {
            ticker: value,
            source: 'mapping',
            confidence: 0.8
          };
        }
      }

      // 2b. Try Exchange lists (BIST / US) heuristics
      try {
        const nameLower = normalized.toLowerCase();
        // BIST entries have "Kod" and "Şirket Adı"
        if (Array.isArray((BistTickers as any))) {
          for (const e of (BistTickers as any)) {
            const company = (e['Şirket Adı'] || e['Sirket Adı'] || '').toString().toUpperCase();
            const code = (e['Kod'] || e['Code'] || '').toString().toUpperCase();
            if (!company) continue;
            if (company.includes(normalized) || normalized.includes(company.toUpperCase())) {
              return { ticker: `IS:${code}`, source: 'mapping', confidence: 0.95, market: 'Istanbul Stock Exchange' };
            }
          }
        }

        // US tickers may be an array of objects with Symbol/Name
        if (Array.isArray((UsTickers as any))) {
          for (const e of (UsTickers as any)) {
            const name = (e['name'] || e['Name'] || e['company'] || '').toString().toUpperCase();
            const sym = (e['symbol'] || e['Symbol'] || e['ticker'] || '').toString().toUpperCase();
            if (!name && !sym) continue;
            if (sym && sym === normalized) return { ticker: sym, source: 'mapping', confidence: 1.0, market: 'US Exchange' };
            if (name && (name.includes(normalized) || normalized.includes(name))) {
              return { ticker: sym || name, source: 'mapping', confidence: 0.95, market: 'US Exchange' };
            }
          }
        }
      } catch (e) {
        logger.warn('Exchange list lookup failed', { error: e });
      }

      // 3. If looks like a ticker already (short, uppercase, 1-5 chars), use as-is
      if (/^[A-Z0-9\-\.@\^]{1,5}$/.test(normalized)) {
        return {
          ticker: normalized,
          source: 'fallback',
          confidence: 0.6
        };
      }

      // 4. Try AI if enabled (provide full context for better inference)
      if (options.useAI && config.openrouterApiKey) {
        try {
          const res = await this.inferTickerWithAI(assetName, options.context);
          return { ticker: res.ticker, source: 'ai', confidence: res.confidence, market: res.market };
        } catch (err) {
          logger.warn('AI ticker inference failed, falling back to asset name', { error: err, assetName });
        }
      }

      // 5. Final fallback: use asset name as-is
      return {
        ticker: normalized,
        source: 'fallback',
        confidence: 0.3
      };
    } catch (err) {
      logger.error('Error normalizing ticker', { error: err, assetName });
      return {
        ticker: assetName.toUpperCase() || 'UNKNOWN',
        source: 'fallback',
        confidence: 0.1
      };
    }
  }

  /**
   * Use AI to infer ticker from asset description
   */
  private async inferTickerWithAI(assetName: string, context?: string): Promise<{ ticker: string; source: 'ai'; confidence: number; market?: string }> {
    const prompt = `You are a financial data expert. Given an asset name, return the appropriate ticker symbol.

Asset Name: "${assetName}"
${context ? `Context: ${context}` : ''}

Return ONLY a JSON object in this format (no markdown, no extra text):
{"ticker": "SYMBOL", "market": "exchange_or_market_type", "confidence": 0.8}

Examples:
- "Apple Inc" -> {"ticker": "AAPL", "market": "NASDAQ", "confidence": 0.95}
- "Turkish Oil Company" -> {"ticker": "IS:THYAO", "market": "Istanbul Stock Exchange", "confidence": 0.85}
- "Bitcoin" -> {"ticker": "BTC", "market": "Crypto", "confidence": 0.98}`;

    const response = await axios.post(
      `${config.openrouterBaseUrl}/chat/completions`,
      {
        model: config.openrouterModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 200
      },
      {
        headers: {
          Authorization: `Bearer ${config.openrouterApiKey}`,
          'HTTP-Referer': 'https://github.com/BaySercan/automated-yt-transcript-cron-job',
          'X-Title': 'Finfluencer Tracker - Ticker Normalization'
        },
        timeout: config.requestTimeout
      }
    );

    let content = response.data?.choices?.[0]?.message?.content || '{}';
    content = content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

    let result: any = {};
    try {
      result = JSON.parse(content);
    } catch (parseErr) {
      // Fallback: extract ticker with regex
      const tickerMatch = content.match(/"ticker"\s*:\s*"([^"]+)"/i);
      if (tickerMatch) {
        result.ticker = tickerMatch[1];
      }
    }

    const ticker = result.ticker || assetName.toUpperCase();
    const confidence = typeof result.confidence === 'number' ? result.confidence : 0.7;
    const market = result.market || result.market_type || undefined;

    return {
      ticker,
      source: 'ai',
      confidence,
      market
    };
  }

  /**
   * Batch normalize multiple asset names
   */
  async normalizeMultiple(assetNames: string[], options: { useAI?: boolean } = {}): Promise<Record<string, { ticker: string; source: string; confidence?: number }>> {
    const results: Record<string, any> = {};
    for (const name of assetNames) {
      results[name] = await this.normalizeTicker(name, options);
    }
    return results;
  }
}

export const tickerNormalizationService = new TickerNormalizationService();
