# Retry Service Documentation

## Overview

The **RetryService** is a robust recovery mechanism designed to handle failed YouTube video predictions in the Automated YouTube Transcript Generator system. It automatically retries failed predictions that couldn't be processed initially, ensuring maximum data recovery and processing efficiency.

## Core Purpose

The retry service addresses transient failures in the YouTube video processing pipeline, specifically:
- Missing or inaccessible YouTube captions
- Temporary API failures
- AI analysis errors
- Network connectivity issues

## How It Works

### Target Selection Logic

The service identifies records eligible for retry based on specific criteria:

1. **Empty Predictions**: Records where `predictions = '[]'`
2. **Retry Count**: Less than the maximum allowed attempts (3)
3. **Priority**: Newer records are processed first (sorted by `post_date` descending)
4. **Batch Limit**: Maximum 50 records processed per execution run

```typescript
// Query criteria for eligible records
.eq('predictions', '[]')
.or(`retry_count.is.null,retry_count.lt.${this.MAX_RETRY_ATTEMPTS}`)
.order('post_date', { ascending: false })
.limit(50);
```

### Retry Flow Process

For each eligible record, the service follows this detailed flow:

1. **Video Info Retrieval**
   - Calls RapidAPI's `/info` endpoint
   - Retrieves automatic captions availability
   - Validates video accessibility

2. **Caption URL Selection**
   - Prioritizes video's default language
   - Falls back to English (`en`)
   - Uses any available language with JSON3 format
   - Selects JSON3 format URLs specifically

3. **Transcript Fetching**
   - Fetches transcript from caption URL
   - Parses YouTube's JSON3 format
   - Extracts text segments from timed events
   - Validates transcript quality (minimum 50 characters)

4. **AI Analysis**
   - Sends transcript to AI analyzer
   - Generates predictions and modifications
   - Handles language detection

5. **Database Update**
   - Updates existing record with new results
   - Clears retry reasons on success
   - Marks record as completed

### Batch Processing Strategy

The service processes records in controlled batches to prevent system overload:

- **Batch Size**: 10 records per batch
- **Inter-batch Delay**: 5 seconds
- **Parallel Processing**: Records within a batch are processed simultaneously
- **Rate Limiting**: Respects YouTube and RapidAPI rate limits

## Configuration Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `MAX_RETRY_ATTEMPTS` | 3 | Maximum retry attempts per record |
| `BATCH_SIZE` | 10 | Records processed per batch |
| `DELAY_BETWEEN_BATCHES` | 5000ms | Delay between batches |

## Trigger Mechanism

### Automatic Trigger

The retry service is automatically triggered as part of the main application execution:

```typescript
// In index.ts - main execution flow
async run(): Promise<void> {
  // ... channel processing ...
  
  // Process failed predictions (idle-time retry)
  await this.processFailedPredictions();
}
```

### Trigger Sequence

1. **Main Execution**: `FinfluencerTracker.run()` starts
2. **Channel Processing**: All active channels are processed for new videos
3. **Idle-Time Retry**: **Immediately after channel processing** completes
4. **Retry Processing**: `processFailedPredictions()` calls the retry service

### Execution Context

- **When**: Runs after normal video processing during each cron job
- **Purpose**: Uses idle processing time for recovery operations
- **Isolation**: Wrapped in try-catch to prevent retry failures from stopping main application
- **Statistics**: Provides detailed logging of retry statistics and results

## Database Schema

### Core Fields

The service works with these database fields in `finfluencer_predictions` table:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Unique record identifier |
| `video_id` | string | YouTube video ID |
| `channel_id` | string | Channel identifier |
| `video_title` | string | Video title |
| `retry_count` | integer | Number of retry attempts (0-3) |
| `last_retry_at` | timestamp | Last retry attempt timestamp |
| `retry_reason` | text | Error message from failed attempts |
| `predictions` | jsonb | Must be empty array for retry eligibility |
| `post_date` | date | Video publication date |

### Retry Status Tracking

The service updates retry status with:

```typescript
// On failure
.update({
  retry_count: retryNumber,
  last_retry_at: new Date().toISOString(),
  retry_reason: reason
})

// On success
.update({
  retry_count: this.MAX_RETRY_ATTEMPTS, // Prevent further retries
  last_retry_at: new Date().toISOString(),
  retry_reason: null // Clear previous errors
})
```

## Error Handling

### Common Retry Reasons

1. **"No automatic captions available"**
   - Video lacks captions/subtitles
   - Captions disabled by creator

2. **"No suitable caption URL found"**
   - No JSON3 format available
   - Caption URL inaccessible

3. **"Transcript too short or empty"**
   - Retrieved transcript < 50 characters
   - Corrupted or empty caption data

### Recovery Strategy

- **Transient Errors**: Automatically retried on next cycle
- **Permanent Errors**: Stop after 3 attempts with detailed logging
- **Network Issues**: Handled gracefully with exponential backoff
- **API Limits**: Respected through batch processing and delays

## Performance Considerations

### Resource Management

- **Memory**: Processes records in batches to prevent memory buildup
- **Network**: Uses delays between batches to respect rate limits
- **Database**: Efficient queries with proper indexing on `retry_count` and `predictions`

### Monitoring and Statistics

The service provides comprehensive statistics:

```typescript
async getRetryStatistics(): Promise<{
  totalEligible: number;
  maxAttemptsReached: number;
  lastRunResults?: any;
}>
```

### Logging

Detailed logging at multiple levels:
- **INFO**: Process start/completion, batch statistics
- **WARN**: Individual retry failures
- **ERROR**: Complete batch failures, system errors
- **DEBUG**: Detailed processing information

## Integration Points

### External Services

1. **Supabase Database**
   - Query failed records
   - Update retry status
   - Store successful results

2. **RapidAPI**
   - Get video information
   - Retrieve caption availability
   - Handle API rate limits

3. **AI Analyzer**
   - Process transcripts
   - Generate predictions
   - Handle language detection

### Service Dependencies

```typescript
import { supabaseService } from './supabase';
import { rapidapiService } from './rapidapi';
import { aiAnalyzer } from './analyzer';
import { logger } from './utils';
```

## Best Practices

### When to Use Manual Retry

Consider manual retry triggers for:
- **High Priority Videos**: Specific important content
- **System Recovery**: After known service outages
- **Batch Operations**: Large-scale recovery operations

### Optimization Tips

1. **Monitor Retry Rates**: High retry rates may indicate system issues
2. **Batch Size Tuning**: Adjust based on API rate limits
3. **Error Analysis**: Regularly review retry reasons for patterns
4. **Database Maintenance**: Clean up old records with max attempts

## Troubleshooting

### Common Issues

1. **No Records Being Retried**
   - Check `predictions` field is truly empty array
   - Verify `retry_count < MAX_RETRY_ATTEMPTS`
   - Ensure records exist in database

2. **High Failure Rate**
   - Check RapidAPI connectivity
   - Verify AI analyzer functionality
   - Review network connectivity

3. **Slow Processing**
   - Consider reducing batch size
   - Check for database performance issues
   - Monitor external API response times

### Debug Commands

```typescript
// Get retry statistics
const stats = await retryService.getRetryStatistics();

// Process specific batch
await retryService.processFailedPredictions();
```

## Future Enhancements

Potential improvements for the retry service:

1. **Smart Retry Intervals**: Exponential backoff for persistent failures
2. **Priority Queues**: High-priority videos processed first
3. **Failure Categorization**: Different strategies for different error types
4. **Manual Override**: Administrative controls for retry operations
5. **Monitoring Dashboard**: Real-time retry statistics and alerts

---

*This documentation covers the retry service implementation as of version 1.1.12. For the latest changes and updates, refer to the source code in `src/retryService.ts`.*
