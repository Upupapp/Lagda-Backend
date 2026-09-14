// @lagda/scanning — malware scanning adapters.
//
// ClamAV's protocol lives in exactly one file here and appears in no exported
// type. Everything above works with the `MalwareScanner` port (INV-221).
// MetaDefender's HTTP protocol is the same shape — a second, swappable
// adapter behind the same port, never the long-term default (see
// config.ts's MALWARE_SCANNER_PROVIDER and its own file header).

export { createClamAvScanner, type ClamAvConfig } from "./clamav/clamav-scanner.js";
export { createMetaDefenderScanner, type MetaDefenderConfig } from "./metadefender/metadefender-scanner.js";
export { loadScannerConfig, ScannerConfigError, type ScannerConfig } from "./config.js";
