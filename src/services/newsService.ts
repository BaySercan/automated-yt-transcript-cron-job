import axios from "axios";
import * as cheerio from "cheerio";
import { supabaseService } from "../supabase";
import { config } from "../config";
import { logger, retryWithBackoff, cleanJsonResponse, sleep } from "../utils";
import { reportingService } from "./reportingService";

interface NewsItem {
  title: string;
  url: string;
  source: string;
  published_at: string;
  summary?: string;
  full_content?: string;
  image_url?: string;
  category?: string;
  impact?: any;
}

interface AIAnalysisResult {
  is_financial_related: boolean;
  summary: string;
  category: string;
  impact: {
    overall:
      | "very-positive"
      | "positive"
      | "neutral"
      | "negative"
      | "very-negative";
    stocks:
      | "very-positive"
      | "positive"
      | "neutral"
      | "negative"
      | "very-negative";
    crypto:
      | "very-positive"
      | "positive"
      | "neutral"
      | "negative"
      | "very-negative";
    forex:
      | "very-positive"
      | "positive"
      | "neutral"
      | "negative"
      | "very-negative";
    commodities:
      | "very-positive"
      | "positive"
      | "neutral"
      | "negative"
      | "very-negative";
  };
}

export class NewsService {
  private readonly feeds = [
    { url: "http://feeds.benzinga.com/benzinga", source: "Benzinga" },
    {
      url: "https://fortune.com/feed/fortune-feeds/?id=3230629",
      source: "Fortune",
    },
    { url: "https://moneyweek.com/feed/all", source: "MoneyWeek" },
    { url: "https://dealbreaker.com/.rss/full/", source: "Dealbreaker" },
    {
      url: "https://ishookfinance.com/rss/latest-posts",
      source: "Ishook Finance",
    },
  ];

  async processNews(): Promise<void> {
    logger.info("📰 Starting News Processing...");

    try {
      // 1. Fetch & Parse all feeds
      const allItems: NewsItem[] = [];
      for (const feed of this.feeds) {
        try {
          reportingService.incrementNewsFeedsChecked();
          const items = await this.fetchAndParseFeed(feed.url, feed.source);
          allItems.push(...items);
        } catch (error) {
          logger.error(`Failed to fetch feed ${feed.url}`, { error });
          reportingService.incrementNewsErrors();
        }
      }

      // Track total items found
      reportingService.addNewsItemsFound(allItems.length);
      logger.info(`Found ${allItems.length} total news items from RSS feeds`);

      // 2. Filter existing URLs
      const newItems = await this.filterNewItems(allItems);
      logger.info(`Found ${newItems.length} new items to process`);

      // 3. Process new items (Scrape + AI Analyze + Save)
      for (const item of newItems) {
        try {
          reportingService.incrementNewsProcessed();
          await this.processSingleItem(item);
          // Rate limit delay
          await sleep(2000);
        } catch (error) {
          logger.error(`Failed to process news item: ${item.title}`, { error });
          reportingService.incrementNewsErrors();
        }
      }

      // 4. Cleanup old news (> 30 days)
      await this.cleanupOldNews();

      logger.info("✅ News processing completed");
    } catch (error) {
      logger.error("❌ News processing failed", { error });
      reportingService.incrementNewsErrors();
    }
  }

  private async fetchAndParseFeed(
    url: string,
    source: string
  ): Promise<NewsItem[]> {
    logger.info(`Fetching feed from ${source}...`);
    try {
      const response = await axios.get(url, { timeout: 10000 });
      const $ = cheerio.load(response.data, { xmlMode: true });
      const items: NewsItem[] = [];

      $("item").each((_, element) => {
        const title = $(element).find("title").text().trim();
        const link = $(element).find("link").text().trim();
        const pubDate = $(element).find("pubDate").text().trim();

        if (title && link) {
          items.push({
            title,
            url: link,
            source,
            published_at: pubDate
              ? new Date(pubDate).toISOString()
              : new Date().toISOString(),
          });
        }
      });

      return items;
    } catch (e: any) {
      throw e;
    }
  }

  private async filterNewItems(items: NewsItem[]): Promise<NewsItem[]> {
    if (items.length === 0) return [];

    const urls = items.map((i) => i.url);
    const { data: existing, error } = await supabaseService
      .getClient()
      .from("news_items")
      .select("url")
      .in("url", urls);

    if (error) {
      logger.error("Failed to check existing news items", { error });
      return [];
    }

    const existingUrls = new Set(existing?.map((e) => e.url) || []);
    return items.filter((i) => !existingUrls.has(i.url));
  }

  private async processSingleItem(item: NewsItem): Promise<void> {
    logger.info(`Processing: ${item.title}`);

    // A. Scrape content
    const scraped = await this.scrapeArticle(item.url);
    if (!scraped) {
      logger.warn(`Skipping - Could not scrape content: ${item.url}`);
      return;
    }

    // B. AI Analysis
    const analysis = await this.analyzeWithAI(item.title, scraped.content);
    if (!analysis || !analysis.is_financial_related) {
      logger.info(`Skipping - Not financial/market related: ${item.title}`);
      reportingService.incrementNewsNonFinancial();
      return;
    }

    // C. Save to DB
    const { error } = await supabaseService
      .getClient()
      .from("news_items")
      .insert({
        title: item.title,
        url: item.url,
        source: item.source,
        published_at: item.published_at,
        summary: analysis.summary,
        category: analysis.category,
        impact: analysis.impact,
        full_content: scraped.content,
        image_url: scraped.imageUrl,
      });

    if (error) {
      reportingService.incrementNewsErrors();
      throw error;
    }

    reportingService.incrementNewsSaved();
    logger.info(`✅ Saved news: ${item.title} [${analysis.category}]`);
  }

  private async scrapeArticle(
    url: string
  ): Promise<{ content: string; imageUrl?: string } | null> {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      const $ = cheerio.load(response.data);

      // Remove scripts, styles, nav, footer, ads to clean up
      $(
        "script, style, nav, footer, header, aside, .ad, .advertisement, .social-share, .comments"
      ).remove();

      // Try to find the main article body
      // Common selectors for article content
      let content =
        $("article").text().trim() ||
        $("main").text().trim() ||
        $(".post-content").text().trim() ||
        $(".article-body").text().trim() ||
        $("body").text().trim(); // Fallback

      // Sanitize whitespace
      content = content.replace(/\s+/g, " ").slice(0, 10000); // Limit length to avoid token limits

      // Get OG Image
      const imageUrl =
        $('meta[property="og:image"]').attr("content") ||
        $('meta[name="twitter:image"]').attr("content");

      if (content.length < 200) return null; // Too short to be useful

      return { content, imageUrl };
    } catch (error) {
      logger.warn(`Scraping failed for ${url}`, {
        error: (error as Error).message,
      });
      return null; // Continue execution even if scraping fails
    }
  }

  private async analyzeWithAI(
    title: string,
    content: string
  ): Promise<AIAnalysisResult | null> {
    const prompt = `
You are a Financial News Analyst. Analyze the following news article and extract structured data.

Article Title: "${title}"
Content Excerpt: "${content.slice(0, 3000)}"

TASK:
1. Determine if this is related to financial markets, economy, crypto, stocks, or geopolitics affecting markets.
2. If YES, generate a short punchy summary (max 5 sentences).
3. Assign a category from: "monetary-policy", "earnings", "crypto", "geopolitics", "markets", "economy", etc.
4. Analyze market impact for: overall, stocks, crypto, forex, commodities.
   Ratings: "very-positive", "positive", "neutral", "negative", "very-negative".

OUTPUT JSON FORMAT (Only return valid JSON):
{
  "is_financial_related": boolean,
  "summary": "string",
  "category": "string",
  "impact": {
    "overall": "rating",
    "stocks": "rating",
    "crypto": "rating",
    "forex": "rating",
    "commodities": "rating"
  }
}
`;

    try {
      const response = await retryWithBackoff(async () => {
        return axios.post(
          `${config.openrouterBaseUrl}/chat/completions`,
          {
            model: config.openrouterModel,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
          },
          {
            headers: {
              Authorization: `Bearer ${config.openrouterApiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://finfluencer.me",
              "X-Title": "Finfluencer Tracker",
            },
            timeout: 60000,
          }
        );
      });

      const rawContent = response.data.choices[0]?.message?.content;
      if (!rawContent) return null;

      const cleanedInfo = cleanJsonResponse(rawContent);
      return JSON.parse(cleanedInfo);
    } catch (error) {
      logger.error("AI Analysis failed", { error: (error as Error).message });
      return null;
    }
  }

  private async cleanupOldNews(): Promise<void> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { error } = await supabaseService
      .getClient()
      .from("news_items")
      .delete()
      .lt("published_at", thirtyDaysAgo.toISOString());

    if (error) {
      logger.error("Failed to cleanup old news", { error });
    } else {
      logger.info("Cleaned up news older than 30 days");
    }
  }
}

export const newsService = new NewsService();
