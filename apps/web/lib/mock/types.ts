import type { Bucket } from "../api";
import type { Locale } from "../i18n/config";

/** Shapes of the files scripts/record-preview.mjs writes into apps/web/preview-data/. */

/** One API response exactly as the real stack answered it. */
export interface Recorded<T = unknown> {
  status: number;
  body: T;
}

export interface PreviewMeta {
  version: 1;
  /** When the recording ran (ISO timestamp). */
  recordedAt: string;
  /** "Today" (UTC) on the recorded stack: the last day of every recorded period. */
  recordedDay: string;
  /** The API it was recorded from. */
  source: string;
  demoEmail: string;
  tenantName: string;
  /** The view the two exports were recorded for, and the file names the API gave them. */
  exports: { days: number; bucket: Bucket; xlsx: string; pdf: string };
}

/** Keyed by "GET /path?query", as the UI requests it (e.g. "GET /metrics/dashboard?days=30&bucket=day"). */
export type RecordedResponses = Record<string, Recorded>;

/** The Ask page's example questions in every UI language, each with the answer the preview replays. */
export interface RecordedAnswer extends Recorded {
  locale: Locale;
  key: string;
  question: string;
  /**
   * Set when this is the recorded answer to the English version of the same example (the demo
   * documents are English and the stack could not answer this language from them); the UI says so.
   */
  answeredAs?: string;
}
