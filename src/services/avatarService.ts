/**
 * Avatar Service
 *
 * Downloads finfluencer avatars from YouTube and uploads them to Supabase Storage.
 * Converts images to WebP format for optimal size and compatibility.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils";
import sharp from "sharp";

const AVATAR_BUCKET = "finfluncer_avatars";

export class AvatarService {
  private supabase: SupabaseClient;

  constructor(supabaseClient: SupabaseClient) {
    this.supabase = supabaseClient;
  }

  /**
   * Downloads an image from a URL and returns it as a Buffer.
   */
  private async downloadImage(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Converts an image buffer to WebP format.
   */
  private async convertToWebP(imageBuffer: Buffer): Promise<Buffer> {
    return sharp(imageBuffer)
      .resize(800, 800, {
        fit: "cover",
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer();
  }

  /**
   * Uploads an avatar to Supabase Storage.
   * Returns the public URL of the uploaded file.
   */
  async uploadAvatar(
    channelId: string,
    thumbnailUrl: string
  ): Promise<string | null> {
    try {
      if (!thumbnailUrl) {
        logger.warn(`No thumbnail URL provided for channel ${channelId}`);
        return null;
      }

      logger.info(`📸 Downloading avatar for channel ${channelId}...`);

      // Download the image
      const imageBuffer = await this.downloadImage(thumbnailUrl);

      // Convert to WebP
      const webpBuffer = await this.convertToWebP(imageBuffer);

      const fileName = `${channelId}.webp`;

      // Upload to Supabase Storage (upsert by using the same filename)
      const { error: uploadError } = await this.supabase.storage
        .from(AVATAR_BUCKET)
        .upload(fileName, webpBuffer, {
          contentType: "image/webp",
          upsert: true, // Overwrite if exists
        });

      if (uploadError) {
        logger.error(`Failed to upload avatar for ${channelId}:`, uploadError);
        return null;
      }

      // Get the public URL
      const {
        data: { publicUrl },
      } = this.supabase.storage.from(AVATAR_BUCKET).getPublicUrl(fileName);

      logger.info(`✅ Avatar uploaded for ${channelId}: ${publicUrl}`);

      return publicUrl;
    } catch (error) {
      logger.error(`Error uploading avatar for channel ${channelId}:`, error);
      return null;
    }
  }

  /**
   * Extracts the high-res thumbnail URL from channel_info.
   */
  static getHighResThumbnail(channelInfo: any): string | null {
    const snippet = channelInfo?.snippet;
    if (!snippet?.thumbnails) return null;

    // Prefer high > medium > default
    return (
      snippet.thumbnails.high?.url ||
      snippet.thumbnails.medium?.url ||
      snippet.thumbnails.default?.url ||
      null
    );
  }
}
