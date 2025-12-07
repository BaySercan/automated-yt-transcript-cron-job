import axios from 'axios';
import { logger } from '../utils';

export class YahooService {
  private readonly USER_AGENT = 'Mozilla/5.0';

  /**
   * Fetch historical prices for a date range
   * Returns a map of YYYY-MM-DD -> price
   */
  async getHistoryRange(symbol: string, startDate: Date, endDate: Date): Promise<Map<string, number>> {
      try {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
  
        const period1 = Math.floor(start.getTime() / 1000);
        const period2 = Math.floor(end.getTime() / 1000);
  
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
        
        logger.info(`YahooService: Fetching batch history for ${symbol} from ${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}...`);
  
        const res = await axios.get(url, {
          headers: { "User-Agent": this.USER_AGENT },
          timeout: 10000
        });
  
        const result = res.data.chart?.result?.[0];
        if (!result) return new Map();
  
        const quote = result.indicators?.quote?.[0];
        const adjClose = result.indicators?.adjclose?.[0]?.adjclose;
        const timestamps = result.timestamp;
  
        if (!quote || !quote.close || !timestamps || quote.close.length === 0) {
          return new Map();
        }
  
        const priceMap = new Map<string, number>();
  
        for (let i = 0; i < timestamps.length; i++) {
            const ts = timestamps[i];
            const candleDate = new Date(ts * 1000);
            const candleDateStr = candleDate.toISOString().split('T')[0];
            
            const closeVal = quote.close[i];
            const adjCloseVal = adjClose ? adjClose[i] : null;
            
            if (closeVal !== null && closeVal !== undefined) {
                const finalPrice = adjCloseVal || closeVal;
                priceMap.set(candleDateStr, finalPrice);
            }
        }
        
        logger.info(`YahooService: Found ${priceMap.size} prices for ${symbol} in range`);
        return priceMap;
  
      } catch (error: any) {
        logger.error(`YahooService Batch Error: ${error.message}`);
        return new Map();
      }
  }

  /**
   * Fetch historical price for a specific date using the public Chart API
   * Endpoint: https://query2.finance.yahoo.com/v8/finance/chart/{symbol}
   */
  async getHistory(symbol: string, date: Date): Promise<number | null> {
    // Optimization: If we just need one date, default logic is fine, 
    // but we could also use getHistoryRange internally if we wanted.
    // Keeping original valid for single checks, but PriceService will prefer batch.
    try {
      // Yahoo Chart API uses Unix timestamps (seconds)
      // We request a 3-day window to handle timezone differences and market hours
      // period1 = date - 1 day (start of previous day)
      // period2 = date + 2 days (end of next day)
      const start = new Date(date);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      
      const end = new Date(date);
      end.setDate(end.getDate() + 2);
      end.setHours(0, 0, 0, 0);

      const period1 = Math.floor(start.getTime() / 1000);
      const period2 = Math.floor(end.getTime() / 1000);

      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
      
      logger.info(`YahooService: Fetching history for ${symbol} around ${date.toISOString().split('T')[0]} (3-day window)...`);
      logger.debug(`YahooService: URL: ${url}`);

      const res = await axios.get(url, {
        headers: { 
          "User-Agent": this.USER_AGENT
        },
        timeout: 10000
      });

      const result = res.data.chart?.result?.[0];
      if (!result) {
        logger.warn(`YahooService: No data returned for ${symbol}`);
        return null;
      }

      const quote = result.indicators?.quote?.[0];
      const adjClose = result.indicators?.adjclose?.[0]?.adjclose;
      const timestamps = result.timestamp;

      if (!quote || !quote.close || !timestamps || quote.close.length === 0) {
        logger.warn(`YahooService: No price data found for ${symbol}`);
        return null;
      }

      // Find the candle that matches our target date
      // We check if the candle timestamp falls within the target date in the exchange's local time
      // or simply matches the YYYY-MM-DD of the target date
      const targetDateStr = date.toISOString().split('T')[0];

      for (let i = 0; i < timestamps.length; i++) {
          const ts = timestamps[i];
          const candleDate = new Date(ts * 1000);
          const candleDateStr = candleDate.toISOString().split('T')[0];
          
          // Check exact date match (UTC)
          // Note: Yahoo timestamps are usually market close or open in UTC
          // For indices, it might be 17:00 UTC previous day or 00:00 UTC current day
          // We'll check if the candle date matches the target date
          if (candleDateStr === targetDateStr) {
              const closeVal = quote.close[i];
              const adjCloseVal = adjClose ? adjClose[i] : null;
              
              if (closeVal !== null && closeVal !== undefined) {
                  const finalPrice = adjCloseVal || closeVal;
                  logger.info(`YahooService: Found match for ${symbol} on ${targetDateStr}: ${finalPrice}`);
                  return finalPrice;
              }
          }
      }

      logger.warn(`YahooService: No matching candle found for ${symbol} on ${targetDateStr} in fetched window`);
      return null;

    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn(`YahooService: Symbol ${symbol} not found`);
        return null;
      }
      logger.error(`YahooService Error: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Resolve asset name to Yahoo Finance symbol using Search API
   * Endpoint: https://query2.finance.yahoo.com/v1/finance/search
   */
  async search(query: string): Promise<string | null> {
      try {
          const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`;
          
          const res = await axios.get(url, {
            headers: { "User-Agent": this.USER_AGENT },
            timeout: 5000
          });

          const quotes = res.data?.quotes;
          if (quotes && quotes.length > 0) {
              // Prefer equity or index if multiple results, but taking the first is usually fine
              // The API usually ranks best match first
              const best = quotes[0];
              logger.info(`YahooService: Resolved "${query}" to ${best.symbol} (${best.shortname || best.longname})`);
              return best.symbol;
          }
          
          logger.warn(`YahooService: No symbol found for "${query}"`);
          return null;
      } catch (error: any) {
          logger.error(`YahooService Search Error: ${error.message}`);
          return null;
      }
  }
}

export const yahooService = new YahooService();
