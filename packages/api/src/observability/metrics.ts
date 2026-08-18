// The metric catalog moved to `@lagda/application` (BACKEND-45).
//
// It had no imports at all — a closed union of names, an allowlist of labels
// and a three-method port. None of that is an HTTP concern, and the worker
// needs every part of it to measure a delivery. Leaving it here would have
// meant the worker importing the HTTP package to name a counter, which is the
// same objection that moved the secret box to `@lagda/security`.
//
// Re-exported rather than relocated in every caller: twenty-two files in this
// package import from this path, and a mechanical rewrite of all of them would
// bury the one decision worth reading in a diff nobody finishes.

export {
  METRIC_NAMES, METRIC_LABELS, noopMetrics, createInMemoryMetrics,
  normalizeRoute, statusFamily,
  type MetricName, type LabelsFor, type MetricsRecorder,
} from "@lagda/application";

