// The recorded fixtures are generated (scripts/record-preview.mjs), not committed. Declaring them here
// keeps type-checking independent of a recording; webpack resolves "@preview-data" only in preview
// builds (next.config.mjs), and fails the build with a clear message when the files are missing.

declare module "@preview-data/meta.json" {
  const meta: import("./types").PreviewMeta;
  export default meta;
}

declare module "@preview-data/responses.json" {
  const responses: import("./types").RecordedResponses;
  export default responses;
}

declare module "@preview-data/ask.json" {
  const answers: import("./types").RecordedAnswer[];
  export default answers;
}

// Emitted as plain files next to the JS bundle; the import is their URL.
declare module "@preview-data/export.xlsx" {
  const url: string;
  export default url;
}

declare module "@preview-data/export.pdf" {
  const url: string;
  export default url;
}
