
import { combinedPredictionsService } from './combinedPredictionsService';
import * as dotenv from 'dotenv';

dotenv.config();

async function testEnrichment() {
  console.log('Starting enrichment test...');
  try {
    const result = await combinedPredictionsService.processPredictions({
      limit: 1,
      dryRun: true,
      enableAIAnalysis: true
    });
    console.log('Test Result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Test Failed:', error);
  }
}

testEnrichment();
