import type { NextFunction, Request, Response } from "express";
import client from "@prometheus-io/client";

/** A registry per process, labelled with the service so dashboards can split api vs worker. */
export function createRegistry(service: "api" | "worker") {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
  return registry;
}

// Buckets cover 5ms cache hits up to 10s LLM calls.
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type HttpLabel = "method" | "route" | "status_code";

/**
 * RED metrics per route. The label is the route *template* (/api/v1/documents/:id), never the raw
 * URL, so IDs can't explode label cardinality; unmatched paths collapse into one series.
 */
export function httpMetrics(registry: client.Registry) {
  // app.ts builds one app when it is imported (the default export Vercel serves) and tests build more
  // with createApp(), so reuse the registry's histogram: registering a name twice throws.
  const duration =
    (registry.getSingleMetric("http_request_duration_seconds") as client.Histogram<HttpLabel> | undefined) ??
    new client.Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency by route",
      labelNames: ["method", "route", "status_code"],
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    });

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/metrics") return next();
    const end = duration.startTimer();
    res.once("finish", () => {
      const mount = (res.locals.mount as string | undefined) ?? "";
      const route =
        req.route?.path !== undefined
          ? `${mount}${req.route.path === "/" ? "" : req.route.path}`
          : mount
            ? `${mount}/*` // rejected by router middleware (e.g. auth) before reaching a route
            : "unmatched";
      end({ method: req.method, route: route || "/", status_code: String(res.statusCode) });
    });
    next();
  };
}

/**
 * Records a router's mount path on entry. Express resets req.baseUrl when an error propagates out of
 * the router, so by the time a 4xx/5xx response finishes the prefix would otherwise be lost.
 */
export function markMount(req: Request, res: Response, next: NextFunction) {
  res.locals.mount = req.baseUrl;
  next();
}
