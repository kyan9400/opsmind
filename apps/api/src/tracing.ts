/**
 * OpenTelemetry bootstrap, preloaded before the app via NODE_OPTIONS="--import ./dist/tracing.js".
 * A no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so local runs and tests pay nothing.
 *
 * Service name and exporter endpoint come from the standard OTEL_* environment variables.
 */
import { register } from "node:module";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // ESM apps need the import-in-the-middle hook so instrumentations can patch modules loaded via `import`.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // File-system spans are pure noise for a web service.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // Scrapes and probes every few seconds would drown out real traffic.
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: (req) => ["/metrics", "/health", "/ready"].includes(req.url ?? ""),
        },
      }),
    ],
  });
  sdk.start();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void sdk.shutdown().catch(() => {}));
  }
}
