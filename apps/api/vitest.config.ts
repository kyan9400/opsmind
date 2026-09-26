import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-at-least-16-chars",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://opsmind:opsmind@localhost:5432/opsmind_test",
    },
  },
});
