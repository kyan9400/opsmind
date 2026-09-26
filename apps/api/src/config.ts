import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  API_PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const config = Env.parse(process.env);
