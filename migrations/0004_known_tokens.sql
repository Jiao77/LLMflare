ALTER TABLE usage_events ADD COLUMN known_tokens INTEGER NOT NULL DEFAULT 0;

UPDATE usage_events
SET known_tokens = COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))
WHERE usage_source = 'exact';
