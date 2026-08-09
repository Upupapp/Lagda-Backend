// @lagda/scanning — malware scanning adapters.
//
// ClamAV's protocol lives in exactly one file here and appears in no exported
// type. Everything above works with the `MalwareScanner` port (INV-221).

export { createClamAvScanner, type ClamAvConfig } from "./clamav/clamav-scanner.js";
export { loadScannerConfig, ScannerConfigError } from "./config.js";
