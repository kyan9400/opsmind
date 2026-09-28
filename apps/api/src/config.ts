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
});

export const config = Env.parse(process.env);
