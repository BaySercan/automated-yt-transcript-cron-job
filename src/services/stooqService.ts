import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils';

export interface StooqResult {
  close: number | null;
  source: 'stooq';
}

export class StooqService {
  private readonly BASE_URL = 'https://stooq.com/q/d/l/';
  private readonly TEMP_DIR = path.join(process.cwd(), 'temp');

  constructor() {
    // Ensure temp directory exists
    if (!fs.existsSync(this.TEMP_DIR)) {
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    }
  }

  /**
   * Normalize Yahoo Finance symbol to Stooq format
   */
  private normalizeSymbol(yahooSymbol: string): string {
    const symbol = yahooSymbol.trim();

    // Indices: Keep ^ and lowercase the rest
    if (symbol.startsWith('^')) {
      return symbol.toLowerCase();
    }

    // Forex: Remove =X and lowercase
    if (symbol.includes('=X')) {
      return symbol.replace('=X', '').toLowerCase();
    }

    // Futures/Commodities: Replace =F with .f and lowercase
    if (symbol.includes('=F')) {
      return symbol.replace('=F', '').toLowerCase() + '.f';
    }

    // BIST 100 (Turkey)
    if (symbol.toUpperCase() === 'XU100.IS' || symbol.toUpperCase() === 'BIST100') {
      return '^xutry';
    }

    // Stocks/ETFs (US): Lowercase and add .us suffix
    // Default behavior for regular stock symbols
    return symbol.toLowerCase() + '.us';
  }

  /**
   * Format date to YYYYMMDD format required by Stooq
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  /**
   * Fetch historical price from Stooq for a specific date
   */
  /**
   * Fetch historical price from Stooq for a specific date
   * Retries up to 3 previous days if data is missing (common for Stooq/BIST)
   */
  async getHistoricalPrice(yahooSymbol: string, date: Date): Promise<StooqResult> {
    const MAX_RETRIES = 3;
    let currentDate = new Date(date);
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.fetchSingleDate(yahooSymbol, currentDate);
      
      if (result.close !== null) {
        if (attempt > 0) {
          logger.info(`Stooq: Found price on retry attempt ${attempt} for ${yahooSymbol} (Date: ${this.formatDate(currentDate)})`);
        }
        return result;
      }

      // If no data, try previous day
      logger.info(`Stooq: No data for ${yahooSymbol} on ${this.formatDate(currentDate)}. Retrying previous day...`);
      currentDate.setDate(currentDate.getDate() - 1);
    }

    logger.warn(`Stooq: Failed to find price for ${yahooSymbol} after ${MAX_RETRIES} retries`);
    return { close: null, source: 'stooq' };
  }

  private async fetchSingleDate(yahooSymbol: string, date: Date): Promise<StooqResult> {
    let tempFilePath: string | null = null;

    try {
      const stooqSymbol = this.normalizeSymbol(yahooSymbol);
      const dateStr = this.formatDate(date);

      logger.debug(`Fetching Stooq price for ${stooqSymbol} on ${dateStr}`);

      // Build URL
      const url = `${this.BASE_URL}?s=${stooqSymbol}&d1=${dateStr}&d2=${dateStr}&i=d`;

      // Download CSV
      const response = await axios.get(url, {
        timeout: 15000,
        responseType: 'text'
      });

      const csvData = response.data;

      // Parse CSV
      const lines = csvData.trim().split('\n');

      // Check if we have at least header + data
      if (lines.length < 2) {
        return { close: null, source: 'stooq' };
      }

      // Skip header, get data line
      const dataLine = lines[1];
      const columns = dataLine.split(',');

      // Close is at index 4: Date,Open,High,Low,Close,Volume
      if (columns.length < 5) {
        return { close: null, source: 'stooq' };
      }

      const closePrice = parseFloat(columns[4]);

      if (isNaN(closePrice)) {
        return { close: null, source: 'stooq' };
      }

      return { close: closePrice, source: 'stooq' };

    } catch (error: any) {
      logger.error(`Error fetching from Stooq for ${yahooSymbol}:`, {
        error: error.message,
        status: error.response?.status
      });
      return { close: null, source: 'stooq' };
    } finally {
      // Clean up temp file if it exists
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          // ignore
        }
      }
    }
  }
}

export const stooqService = new StooqService();
