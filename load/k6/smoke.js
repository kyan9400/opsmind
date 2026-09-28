// Smoke: one user walks every key endpoint for 30s. Proves the scripts and the
// stack agree before spending minutes on the real load profile.
//   k6 run -e API=http://localhost:4000 load/k6/smoke.js
import { sleep } from "k6";
import { bootstrapTenant, endpoints } from "./lib.js";

export const options = {
  vus: 1,
  duration: "30s",
  setupTimeout: "120s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  return bootstrapTenant({ withDocument: true });
}

export default function ({ token, documentId }) {
  endpoints.me(token);
  endpoints.dashboard(token);
  endpoints.insights(token);
  endpoints.documents(token);
  endpoints.document(token, documentId);
  endpoints.ask(token);
  sleep(1);
}
