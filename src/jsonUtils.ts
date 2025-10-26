// Enhanced JSON cleaning and parsing for AI responses

// Enhanced JSON cleaning for problematic AI responses
export function enhancedCleanJsonResponse(response: string): string {
  let cleaned = response.trim();
  
  // Remove markdown code blocks
  cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
  
  // Remove common AI response prefixes
  cleaned = cleaned.replace(/^(Here is|Here's|The result is|Result:)\s*/i, '');
  
  // Fix corrupted AI commentary (e.g., "commentary to=assistant```jsoncjsoncjsonc...")
  cleaned = cleaned.replace(/.*commentary to=assistant.*?jsonc+/gi, '');
  
  // Handle repeated "jsoncjsoncjsonc..." patterns
  cleaned = cleaned.replace(/jsonc+/gi, '');
  
  // Fix common JSON formatting issues
  cleaned = cleaned.replace(/,\s*}/g, '}'); // Remove trailing commas
  cleaned = cleaned.replace(/,\s*]/g, ']'); // Remove trailing commas in arrays
  
  // Handle escaped quotes
  cleaned = cleaned.replace(/\\"/g, '"');
  
  return cleaned.trim();
}

// Extract JSON from malformed responses containing explanatory text
export function extractJsonFromMixedResponse(response: string): string | null {
  const jsonStartIndex = response.indexOf('{');
  const jsonEndIndex = response.lastIndexOf('}');
  
  if (jsonStartIndex !== -1 && jsonEndIndex !== -1 && jsonEndIndex > jsonStartIndex) {
    return response.substring(jsonStartIndex, jsonEndIndex + 1);
  }
  
  return null;
}

// Attempt to fix unterminated strings in JSON
export function fixUnterminatedStrings(jsonString: string): string {
  let fixed = jsonString;
  
  // Find unterminated strings and close them
  const stringMatches = fixed.match(/"[^"]*$/g);
  if (stringMatches) {
    for (const match of stringMatches) {
      if (!match.endsWith('"')) {
        // Add missing closing quote
        fixed = fixed.replace(match, match + '"');
      }
    }
  }
  
  return fixed;
}

// Validate if string is valid JSON
export function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Enhanced safe JSON parsing with multiple fallback strategies
export function enhancedSafeJsonParse<T>(jsonString: string, fallback: T, logger: any): T {
  // Strategy 1: Standard JSON.parse
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logger.debug('Strategy 1 failed - Standard JSON parsing');
  }
  
  // Strategy 2: Apply enhanced cleaning
  const cleaned = enhancedCleanJsonResponse(jsonString);
  if (isValidJson(cleaned)) {
    logger.info('Strategy 2 success - Enhanced cleaning fixed JSON');
    return JSON.parse(cleaned);
  }
  
  // Strategy 3: Extract JSON portion from mixed response
  const extracted = extractJsonFromMixedResponse(jsonString);
  if (extracted && isValidJson(extracted)) {
    const extractedCleaned = enhancedCleanJsonResponse(extracted);
    if (isValidJson(extractedCleaned)) {
      logger.info('Strategy 3 success - Extracted JSON from mixed response');
      return JSON.parse(extractedCleaned);
    }
  }
  
  // Strategy 4: Fix unterminated strings
  const fixed = fixUnterminatedStrings(cleaned);
  if (isValidJson(fixed)) {
    logger.info('Strategy 4 success - Fixed unterminated strings');
    return JSON.parse(fixed);
  }
  
  // Strategy 5: Try parsing after removing last truncated field
  const lastCommaIndex = cleaned.lastIndexOf(',');
  if (lastCommaIndex !== -1) {
    const truncated = cleaned.substring(0, lastCommaIndex) + '}';
    if (isValidJson(truncated)) {
      logger.info('Strategy 5 success - Removed truncated field');
      return JSON.parse(truncated);
    }
  }
  
  // All strategies failed
  logger.warn('All JSON parsing strategies failed, using fallback', {
    originalLength: jsonString.length,
    cleanedLength: cleaned.length,
    sample: jsonString.substring(0, 100) + '...'
  });
  
  return fallback;
}
