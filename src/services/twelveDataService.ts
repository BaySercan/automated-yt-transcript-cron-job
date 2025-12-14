import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "../utils";

export class TwelveDataService {
  private readonly USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // Base URL for XAUTRYG (Gram Gold / Turkish Lira)
  // ID: 796331, Symbol: GAU/TRY
  private readonly BASE_URL =
    "https://twelvedata.com/markets/796331/commodity/gau-try";
  private readonly HISTORICAL_URL_TEMPLATE =
    "https://twelvedata.com/markets/796331/commodity/gau-try/historical-data?start_date={start_date}&end_date={end_date}&interval=1day";

  /**
   * Get live XAUTRYG price from the main market page
   */
  async getLivePrice(): Promise<number | null> {
    try {
      logger.info("Fetching live XAUTRYG price from Twelve Data...");

      const response = await axios.get(this.BASE_URL, {
        headers: {
          "User-Agent": this.USER_AGENT,
          Accept: "text/html",
        },
        timeout: 15000,
      });

      const $ = cheerio.load(response.data);

      // Selector provided by user: "d-flex align-items-center stats-symbol-price stats-symbol-price--small1"
      // Note: Classes often have spaces, so we use dot notation for the selector
      const selector =
        ".d-flex.align-items-center.stats-symbol-price.stats-symbol-price--small1";
      const priceElement = $(selector);

      if (priceElement.length > 0) {
        // Text is likely something like "2,950 TRY" or just the number
        const priceText = priceElement.text().trim();
        const price = this.parsePrice(priceText);

        if (price !== null) {
          logger.info(`Found live XAUTRYG price: ${price} TRY`);
          return price;
        }
      }

      logger.warn(
        "Could not find live price element with specifically requested selector"
      );
      return null;
    } catch (error: any) {
      logger.error("Error fetching live XAUTRYG price from Twelve Data:", {
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Get historical XAUTRYG price for a specific date
   */
  async getHistoricalPrice(date: Date): Promise<number | null> {
    try {
      const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
      logger.info(
        `Fetching historical XAUTRYG price for ${dateStr} from Twelve Data...`
      );

      // Construct URL
      // We start from the requested date. To be safe, we might request a small range, but user said:
      // "when you fill the start and end dates in the url with the format 2025-01-01"
      // implying start_date = end_date can work or provides the specific row.
      const url = this.HISTORICAL_URL_TEMPLATE.replace(
        "{start_date}",
        dateStr
      ).replace("{end_date}", dateStr);

      const response = await axios.get(url, {
        headers: {
          "User-Agent": this.USER_AGENT,
          Accept: "text/html",
        },
        timeout: 15000,
      });

      const $ = cheerio.load(response.data);

      // "The first column (index[0]) of this table is date... and index[4] is closing price data"
      // We need to find the table.

      let foundPrice: number | null = null;

      $("table tbody tr").each((_i, tr) => {
        const tds = $(tr).find("td");
        if (tds.length >= 5) {
          // Ensure enough columns
          const dateText = $(tds[0]).text().trim(); // Format: Dec 13, 2025

          // Check if this row matches our date
          // The page format is "Dec 13, 2025". Our input is Date object.
          // Let's parse the table date to compare, or format our date to match.
          // Parsing table date to timestamp is safer than string matching if localizations vary.
          const rowDate = new Date(dateText);

          // Compare dates (ignoring time)
          if (!isNaN(rowDate.getTime()) && this.isSameDay(rowDate, date)) {
            const closePriceText = $(tds[4]).text().trim();
            foundPrice = this.parsePrice(closePriceText);
            return false; // Break loop
          }
        }
      });

      if (foundPrice !== null) {
        logger.info(
          `Found historical XAUTRYG price for ${dateStr}: ${foundPrice} TRY`
        );
        return foundPrice;
      }

      logger.warn(
        `Could not find historical price for ${dateStr} in the table`
      );
      return null;
    } catch (error: any) {
      logger.error(
        "Error fetching historical XAUTRYG price from Twelve Data:",
        {
          error: error.message,
        }
      );
      return null;
    }
  }

  /**
   * Parse price string to number, handling comma/dot decimal separators and K suffix
   */
  private parsePrice(text: string): number | null {
    if (!text) return null;

    // Check for K/M suffixes before stripping other chars
    let clean = text.trim().toUpperCase();
    let multiplier = 1;

    if (clean.endsWith("K")) {
      multiplier = 1000;
      clean = clean.slice(0, -1).trim();
    } else if (clean.endsWith("M")) {
      multiplier = 1000000;
      clean = clean.slice(0, -1).trim();
    }

    // remove currency symbols and other non-numeric chars except . and ,
    clean = clean.replace(/[^\d.,]/g, "");

    if (!clean) return null;

    // Check format
    const lastDotIndex = clean.lastIndexOf(".");
    const lastCommaIndex = clean.lastIndexOf(",");

    if (lastCommaIndex > lastDotIndex) {
      // Comma is decimal separator (EU/TR style)
      clean = clean.replace(/\./g, "");
      clean = clean.replace(",", ".");
    } else {
      // Dot is decimal separator (US style)
      clean = clean.replace(/,/g, "");
    }

    const val = parseFloat(clean);
    return isNaN(val) ? null : val * multiplier;
  }

  private isSameDay(d1: Date, d2: Date): boolean {
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  }
}

export const twelveDataService = new TwelveDataService();
