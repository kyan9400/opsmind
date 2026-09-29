import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  API_PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  AI_SERVICE_TOKEN: z.string().min(16).default("dev-internal-token-change-me"),
  // Number of reverse proxies in front of the API (1 behind Caddy), so rate limits see real client IPs.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Login/register attempts per IP per 15 minutes; 0 disables (tests).
  AUTH_RATE_LIMIT: z.coerce.number().int().min(0).default(20),
});

export const config = Env.parse(process.env);
