import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./lib/db.js";

const server = createApp().listen(config.API_PORT, () => {
  console.log(`opsmind api listening on :${config.API_PORT}`);
});

// Graceful shutdown so in-flight requests finish during container rollouts.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
