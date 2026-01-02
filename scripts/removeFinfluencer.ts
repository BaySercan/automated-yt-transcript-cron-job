/**
 * Remove Finfluencer Script
 *
 * This script removes a finfluencer (YouTube channel) and all associated data
 * from all database tables.
 *
 * Usage:
 *   npx ts-node src/removeFinfluencer.ts <channel_id>
 *
 * Example:
 *   npx ts-node src/removeFinfluencer.ts UCV6KDgJskWaEckne5aPA0aQ
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as readline from "readline";

// Load environment variables
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

interface DeletionStats {
  table: string;
  deleted: number;
  error?: string;
}

async function getChannelInfo(
  channelId: string
): Promise<{ name: string; isActive: boolean } | null> {
  const { data, error } = await supabase
    .from("finfluencer_channels")
    .select("channel_name, is_active")
    .eq("channel_id", channelId)
    .single();

  if (error || !data) {
    return null;
  }

  return { name: data.channel_name, isActive: data.is_active };
}

async function countRecords(
  channelId: string
): Promise<{ table: string; count: number }[]> {
  const tables = [
    "finfluencer_channels",
    "finfluencer_predictions",
    "combined_predictions",
  ];

  const counts: { table: string; count: number }[] = [];

  for (const table of tables) {
    const { count, error } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("channel_id", channelId);

    counts.push({
      table,
      count: error ? -1 : count || 0,
    });
  }

  return counts;
}

async function deleteFromTable(
  tableName: string,
  channelId: string
): Promise<DeletionStats> {
  try {
    // First count how many records we'll delete
    const { count: beforeCount } = await supabase
      .from(tableName)
      .select("*", { count: "exact", head: true })
      .eq("channel_id", channelId);

    // Perform the deletion
    const { error } = await supabase
      .from(tableName)
      .delete()
      .eq("channel_id", channelId);

    if (error) {
      return {
        table: tableName,
        deleted: 0,
        error: error.message,
      };
    }

    return {
      table: tableName,
      deleted: beforeCount || 0,
    };
  } catch (err) {
    return {
      table: tableName,
      deleted: 0,
      error: (err as Error).message,
    };
  }
}

async function confirmDeletion(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function removeFinfluencer(channelId: string): Promise<void> {
  console.log("\n🔍 Looking up channel...\n");

  // 1. Get channel info
  const channelInfo = await getChannelInfo(channelId);

  if (!channelInfo) {
    console.log(
      `⚠️  Channel "${channelId}" not found in finfluencer_channels.`
    );
    console.log("   Will still check other tables for orphaned records...\n");
  } else {
    console.log(`📺 Channel Found:`);
    console.log(`   Name: ${channelInfo.name}`);
    console.log(`   ID: ${channelId}`);
    console.log(`   Status: ${channelInfo.isActive ? "Active" : "Inactive"}\n`);
  }

  // 2. Count records in all tables
  console.log("📊 Counting records to delete:\n");
  const counts = await countRecords(channelId);

  let totalRecords = 0;
  for (const { table, count } of counts) {
    if (count === -1) {
      console.log(`   ❓ ${table}: Error counting`);
    } else {
      console.log(`   📁 ${table}: ${count} record(s)`);
      totalRecords += count;
    }
  }

  console.log(`\n   📦 Total: ${totalRecords} record(s)\n`);

  if (totalRecords === 0) {
    console.log("✅ No records found. Nothing to delete.");
    return;
  }

  // 3. Confirm deletion
  const confirmed = await confirmDeletion(
    `⚠️  Are you sure you want to DELETE ALL ${totalRecords} records for this channel? (y/N): `
  );

  if (!confirmed) {
    console.log("\n❌ Deletion cancelled.");
    return;
  }

  // 4. Perform deletions in order (child tables first)
  console.log("\n🗑️  Deleting records...\n");

  const deletionOrder = [
    "combined_predictions", // Child table (depends on predictions)
    "finfluencer_predictions", // Predictions table
    "finfluencer_channels", // Parent table (last)
  ];

  const results: DeletionStats[] = [];

  for (const table of deletionOrder) {
    process.stdout.write(`   Deleting from ${table}...`);
    const result = await deleteFromTable(table, channelId);
    results.push(result);

    if (result.error) {
      console.log(` ❌ Error: ${result.error}`);
    } else {
      console.log(` ✅ ${result.deleted} deleted`);
    }
  }

  // 5. Summary
  console.log("\n📋 Deletion Summary:\n");
  let totalDeleted = 0;
  let hasErrors = false;

  for (const result of results) {
    if (result.error) {
      console.log(`   ❌ ${result.table}: FAILED - ${result.error}`);
      hasErrors = true;
    } else {
      console.log(`   ✅ ${result.table}: ${result.deleted} deleted`);
      totalDeleted += result.deleted;
    }
  }

  console.log(`\n   🎯 Total deleted: ${totalDeleted} records`);

  if (hasErrors) {
    console.log("\n⚠️  Some deletions failed. Check the errors above.");
  } else {
    console.log(
      `\n✅ Successfully removed finfluencer "${
        channelInfo?.name || channelId
      }" from the database.`
    );
  }
}

// Main execution
const channelId = process.argv[2];

if (!channelId) {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Remove Finfluencer Script                        ║
╠════════════════════════════════════════════════════════════╣
║  Usage:                                                    ║
║    npx ts-node src/removeFinfluencer.ts <channel_id>       ║
║                                                            ║
║  Example:                                                  ║
║    npx ts-node src/removeFinfluencer.ts UCxyz123...        ║
║                                                            ║
║  This will remove the channel and ALL associated data:     ║
║    • finfluencer_channels                                  ║
║    • finfluencer_predictions                               ║
║    • combined_predictions                                  ║
╚════════════════════════════════════════════════════════════╝
  `);
  process.exit(1);
}

removeFinfluencer(channelId)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Script failed:", err);
    process.exit(1);
  });
