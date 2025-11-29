-- Add price formatting columns to combined_predictions table
ALTER TABLE combined_predictions 
ADD COLUMN IF NOT EXISTS price_currency VARCHAR(10),
ADD COLUMN IF NOT EXISTS formatted_price VARCHAR(50);

-- Add comment explaining the columns
COMMENT ON COLUMN combined_predictions.price_currency IS 'Currency symbol or code (e.g. $, ₺, USD)';
COMMENT ON COLUMN combined_predictions.formatted_price IS 'Price formatted as integer with currency (e.g. 4500$, 120₺)';
