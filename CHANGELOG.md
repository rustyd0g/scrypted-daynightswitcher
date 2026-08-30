# Changelog

## 1.0.8 - 2026-08-30

* Improved sunrise and sunset scheduling across offsets, restarts, and long-running sessions.
* Added optional startup phase synchronization with an independent per-camera override.
* Serialized camera actions and coalesced duplicate phase requests.
* Added request timeouts, bounded retries, lifecycle cancellation, safer response handling, and redacted configuration logging.
* Added the last successful action and timestamp to the schedule preview.
* Added scheduler, HTTP authentication, retry, timeout, queue, and cleanup tests.
* Added continuous integration for tests, type-checking, and production builds.
* Documented tested Hikvision, Dahua, and EmpireTech configurations.
