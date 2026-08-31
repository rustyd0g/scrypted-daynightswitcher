# Changelog

## 1.0.8 - 2026-08-31

* Improved sunrise and sunset scheduling across offsets, restarts, and long-running sessions.
* Added optional startup phase synchronization with an independent per-camera override.
* Serialized camera actions and coalesced duplicate phase requests.
* Added hourly reconciliation after an exhausted scheduled Day or Night action.
* Added missed-transition detection and cancellation of obsolete automatic actions.
* Corrected solar event history for large offsets and stabilised SunCalc date lookups around midnight.
* Added request timeouts, bounded retries, lifecycle cancellation, safer response handling, and redacted configuration logging.
* Limited automatic request retries to network errors, timeouts, HTTP 408, HTTP 429, and HTTP 5xx responses.
* Extended request timeouts through response consumption without allowing diagnostic logging failures to repeat successful actions.
* Added the last successful action and timestamp to the schedule preview.
* Added scheduler, HTTP authentication, retry, timeout, queue, migration, reconciliation, and cleanup tests.
* Added continuous integration for tests, type-checking, and production builds.
* Updated the Scrypted SDK and compatible transitive build dependencies.
* Documented tested Hikvision, Dahua, and EmpireTech configurations.
