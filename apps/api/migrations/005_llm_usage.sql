-- LLM calls per UTC day, for the whole deployment. The ai service adds one before each call and stops
-- at LLM_DAILY_MAX: past it, answers are extractive and summaries use the template until the next day,
-- so traffic on the public demo cannot spend the provider's whole daily free quota. One small row a day.
CREATE TABLE IF NOT EXISTS llm_usage (
  day    date PRIMARY KEY,
  calls  int NOT NULL
);
