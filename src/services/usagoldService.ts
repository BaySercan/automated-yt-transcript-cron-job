import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "../utils";

export class UsagoldService {
  private readonly USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  private readonly LIVE_GOLD_URL =
    "https://www.usagold.com/live-gold-price-today/";
  private readonly LIVE_SILVER_URL =
    "https://www.usagold.com/live-silver-price-today/";
  private readonly HISTORICAL_GOLD_URL =
    "https://www.usagold.com/daily-gold-price-history/";
  private readonly HISTORICAL_SILVER_URL =
    "https://www.usagold.com/daily-silver-price-history/";

  /**
   * Get live gold price
   */
  async getLiveGoldPrice(): Promise<number | null> {
    return this.getLivePrice(this.LIVE_GOLD_URL, "gold");
  }

  /**
   * Get live silver price
   */
  async getLiveSilverPrice(): Promise<number | null> {
    return this.getLivePrice(this.LIVE_SILVER_URL, "silver");
  }

  /**
   * Generic method to fetch live price
   */
  private async getLivePrice(
    url: string,
    metal: string
  ): Promise<number | null> {
    try {
      logger.info(`Fetching live ${metal} price from USAGOLD...`);

      const response = await axios.get(url, {
        headers: {
          "User-Agent": this.USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        timeout: 15000,
      });

      const $ = cheerio.load(response.data);

      let priceText = "";

      // Strategy 1: Look for "Gold Price" or "Silver Price" specific text in the body to avoid header tickers
      // typically headers show "Gold: $xxx" everywhere.
      // Main content usually has "Silver Price" or "Live Silver Price"
      const label = metal.charAt(0).toUpperCase() + metal.slice(1); // 'Gold' or 'Silver'

      // Find element containing "{Metal} Price" text (case insensitive usually ok but checking exact first)
      // We look for the label, then find the nearest price number
      let foundViaText = false;

      $("div, h1, h2, h3, p, span").each((_i, elem) => {
        const text = $(elem).text();
        // Look for "Silver Price" or "Gold Price" followed closely by a number
        // Avoid "Gold Price" on Silver page if it's just a header link
        if (text.includes(`${label} Price`)) {
          // Look for price pattern $1,234.56 or 1,234.56
          const match = text.match(/(?:[\$]|)\s*(\d{1,3}(,\d{3})*(\.\d+)?)/);
          if (match) {
            // Check if it's the right magnitude?
            // Silver < 200, Gold > 1000 usually. But let's trust the label match first.
            // We prefer the one that Says "Current {Metal} Price"
            if (text.includes("Current") || text.includes("Live")) {
              priceText = match[1];
              foundViaText = true;
              return false; // break
            }

            // If not "Current/Live", store it but keep looking for a better one?
            // Actually, usually the first "Silver Price $XX" in the main body is good.
            if (!priceText) priceText = match[1];
          }
        }
      });

      // Strategy 2: If text search specific to metal failed, try the old generic bdi IF it matches expectation
      if (!priceText) {
        const firstBdi = $("bdi").first().text().trim();
        // Safety check: specific to this bug
        // If we want Silver, and price is > 1000, it's probably Gold.
        // Silver is rarely > $1000. Gold is rarely < $1000.
        if (firstBdi) {
          const val = parseFloat(firstBdi.replace(/[^\d.]/g, ""));
          if (metal.toLowerCase() === "silver" && val > 500) {
            logger.warn(
              `USAGOLD: Detected suspiciously high price for Silver ($${val}). Ignoring generic selector which likely caught Gold header.`
            );
          } else {
            priceText = firstBdi;
          }
        }
      }

      // Strategy 3: "Current Price" generic fallback if we haven't found anything yet
      if (!priceText) {
        $("*").each((_i, elem) => {
          const text = $(elem).text();
          if (text.includes("Current Price")) {
            const match = text.match(/\$?([\d,]+\.?\d*)/);
            if (match) {
              priceText = match[1];
              return false;
            }
          }
        });
      }

      if (!priceText) {
        logger.warn(`Could not find ${metal} price on page`);
        return null;
      }

      // Parse price (clean currency symbols and commas)
      // Removes everything that is not a digit or a decimal point
      const cleanPrice = priceText.replace(/[^\d.]/g, "");
      const price = parseFloat(cleanPrice);

      if (isNaN(price)) {
        logger.warn(`Invalid ${metal} price format: ${priceText}`);
        return null;
      }

      logger.info(`Found live ${metal} price: $${price}`);
      return price;
    } catch (error: any) {
      logger.error(`Error fetching live ${metal} price from USAGOLD:`, {
        error: error.message,
        status: error.response?.status,
      });
      return null;
    }
  }

  /**
   * Get historical gold price for a specific date
   * Note: This method requires browser automation for calendar navigation
   * Fallback to cheerio is attempted but may not work due to JavaScript requirements
   */
  async getHistoricalGoldPrice(date: Date): Promise<number | null> {
    return this.getHistoricalPrice(this.HISTORICAL_GOLD_URL, date, "gold");
  }

  /**
   * Get historical silver price for a specific date
   */
  async getHistoricalSilverPrice(date: Date): Promise<number | null> {
    return this.getHistoricalPrice(this.HISTORICAL_SILVER_URL, date, "silver");
  }

  /**
   * Generic method to fetch historical price
   * This is a simplified version that attempts cheerio scraping
   * For full calendar navigation, browser automation would be needed
   */
  private async getHistoricalPrice(
    url: string,
    date: Date,
    metal: string
  ): Promise<number | null> {
    try {
      const targetYear = date.getFullYear();
      const targetMonth = date.getMonth(); // 0-indexed
      const targetDay = date.getDate();

      logger.info(
        `Attempting to fetch historical ${metal} price for ${
          date.toISOString().split("T")[0]
        } from USAGOLD...`
      );

      // Note: USAGOLD calendar requires JavaScript/browser automation
      // This cheerio approach is a fallback that may not work
      const response = await axios.get(url, {
        headers: {
          "User-Agent": this.USER_AGENT,
          Accept: "text/html",
        },
        timeout: 15000,
      });

      const $ = cheerio.load(response.data);

      // Try to find the price in the pre-loaded calendar (if any)
      // This is unlikely to work as the calendar is typically loaded via JavaScript

      logger.warn(
        `Historical ${metal} price fetching from USAGOLD requires browser automation`
      );
      logger.warn(`Cheerio scraping not supported for calendar navigation`);
      return null;
    } catch (error: any) {
      logger.error(`Error fetching historical ${metal} price from USAGOLD:`, {
        error: error.message,
        status: error.response?.status,
      });
      return null;
    }
  }

  /**
   * Helper to retry a date by going back N days
   * Used to handle weekends/holidays
   */
  private getPreviousDate(date: Date, daysBack: number = 1): Date {
    const newDate = new Date(date);
    newDate.setDate(newDate.getDate() - daysBack);
    return newDate;
  }
}

export const usagoldService = new UsagoldService();
