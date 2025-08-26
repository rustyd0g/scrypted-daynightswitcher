# Day/Night Switcher (Scrypted Plugin)

Automatically switch each camera to your preferred **Day** or **Night** profile at sunrise and sunset.
Works with cameras that expose HTTP endpoints (Hikvision, Dahua, Amcrest, EmpireTech, etc.).

* **Per-camera control** with global defaults
* **Offsets** around sunrise/sunset (e.g. switch 10 min after sunset)
* **Manual run** buttons (*Switch to Day/Night now*)
* **Retries & backoff** for reliability
* **Digest / Basic / None** authentication
* **Schedule preview** with local time and time zone

---

## Quick Start

1. **Disable your camera’s built-in day/night schedule** (set it to *Manual/Fixed/Full Time*).
2. In the plugin’s **Global settings**, enter your **Latitude/Longitude** (On desktop: right-click anywhere on Google Maps → coordinates appear at the top. On mobile: long-press to drop a pin, then swipe up to copy).
3. For each camera, open **Day/Night Switcher** settings, configure the **Day/Night URLs + Method**, and enable switching.

---

## How it works

1. Each day, the plugin calculates **sunrise and sunset times** based on your latitude and longitude, applying any configured offsets.
2. At those scheduled times, it sends the configured **HTTP request** using the URL and method you entered.
3. Requests can include authentication (Digest, Basic, or None), headers, and an optional body. Retries with increasing delays are supported for reliability.
4. The plugin automatically refreshes the schedule every day and displays the next planned switch times in your local time zone.

---

## Installation

1. Install the plugin in Scrypted.
2. In **Global settings**, configure **Latitude** and **Longitude** (and optionally **Time zone**).
3. For each camera, configure Day/Night actions and enable switching.

---

## Camera-side setup (critical)

Before configuring the plugin, prevent the camera’s own schedule or auto logic from conflicting with your commands:

1. **Disable automatic day/night switching** in the camera’s web UI. Look for **Profile Schedule**, **Day/Night Mode**, **Scene Mode**, etc., and set to *Manual/Fixed/Full Time*.
2. **Prepare the profiles/scenes** you want the plugin to trigger (e.g. a “Day” profile and a “Night” profile).
3. **Apply & reboot** if required by your camera’s UI.

You’ll also need the correct **HTTP endpoints** for your model/firmware:

* Check the manufacturer’s API docs or community forums.
* Useful search terms: `<brand> <model> http api`, `ISAPI`, `configManager.cgi`, `cgi day night`, `profile switch`.
* **Test first** with curl or Postman; once working, copy the URL/Method/Headers/Body into the plugin.

---

## Global settings

* **Latitude / Longitude** — decimal degrees (e.g. `51.507351, -0.127758`).
* **Time zone (optional)** — standard time zone ID (e.g. `Europe/London`). **It does not affect when the switch happens** (that’s always based on sunrise/sunset at your latitude/longitude).
* **Use 24-hour time** — UI display preference.
* **Sync phase on startup** — immediately corrects the camera if its current mode doesn’t match the expected phase.
* **Sunrise / Sunset offset (mins, default)** — defaults for all cameras (can be overridden per camera).
* **Reliability defaults:**

  * **HTTP total attempts** — total tries including the first attempt (`1` disables retries).
  * **Retry base delay (ms)** — waits longer between retries (with added jitter).
  * **Log HTTP responses** — log status and response body (chunked, capped).

---

## Per-camera settings

* **Enable Day/Night switching** — master on/off.
* **Override location & time** — per-camera lat/lon/time if needed.
* **Override sunrise/sunset offsets** — per-camera offsets (mins; positive = after, negative = before).
* **Authentication**:

  * **Auth Type** — `digest`, `basic`, or `none`.
  * **Username / Password** — used by the plugin (don’t embed credentials in URLs).
* **Day / Night actions**:

  * **URL** — camera endpoint to trigger the mode.
  * **Method** — `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
  * **Content-Type** — only when sending a **Body**.
  * **Extra Headers (JSON)** — e.g. `{"Accept":"application/xml"}`.
  * **Body** — optional request body for POST/PUT/PATCH/DELETE.
* **Reliability & Logging (per camera)** — override global retries/backoff/logging.
* **Tools (General tab)**:

  * **Schedule preview** — shows next switch times and configuration summary.
  * **Switch to Day/Night now** — fire actions immediately (useful for testing).

---

## Scheduling details

* The plugin maintains two scheduled events: **Sunrise → Day** and **Sunset → Night**.
* These times are updated daily at midnight (with offsets applied).
* After each event runs, the schedule is refreshed to ensure accuracy.
* A guard timer re-checks periodically (every 6 hours by default) to catch long sleeps or restarts.

---

## Configuration examples (tested models)

⚠️ **Important:** The following examples are confirmed on specific models/firmware.
Other cameras may offer different options or use different endpoints.

### Hikvision (ISAPI profile switching)

✅ Confirmed on:

* DS-2CD2347G2H-LIU (Firmware V5.7.19 build 241207)
* DS-2CD2387G2H-LIU (Firmware V5.7.19 build 241207)

**What it does:**
Switches the camera into one of its Scene Modes (for example: custom1, custom2, basic, or low illumination).

**Before you use the plugin:**
In the Hikvision web UI → *Configuration → Image → Display Settings → Scene Mode*:

* Configure `custom1` with your preferred **Day** settings.
* Configure `custom2` with your preferred **Night** settings.

**Day Action (UI fields):**

* **URL:** `http://CAMERA_IP/ISAPI/Image/channels/1/mountingScenario`
* **Method:** `PUT`
* **Content-Type:** `application/xml`
* **Body:**

  ```xml
  <MountingScenario><mode>custom1</mode></MountingScenario>
  ```

**Night Action (UI fields):**

* **URL:** `http://CAMERA_IP/ISAPI/Image/channels/1/mountingScenario`
* **Method:** `PUT`
* **Content-Type:** `application/xml`
* **Body:**

  ```xml
  <MountingScenario><mode>custom2</mode></MountingScenario>
  ```

---

### Dahua / Amcrest / EmpireTech

✅ Confirmed on:

* IPC-HDW5442TM-AS (Firmware V2.840.0000000.30.R, Build Date: 2025-02-27)

**What it does:**
Toggles the **Day/Night mode setting** to *Day (0)* or *Night (1)*, applying the profile you’ve configured for each.

**Before you use the plugin:**
In the Dahua web UI → *Setup → Camera → Conditions → Day/Night*, confirm you can manually set Day and Night profiles (and disable auto).

**Day Action (UI fields):**

* **URL:**

  ```
  http://CAMERA_IP/cgi-bin/configManager.cgi?action=setConfig&VideoInMode[0].Config[0]=0
  ```
* **Method:** `GET`

**Night Action (UI fields):**

* **URL:**

  ```
  http://CAMERA_IP/cgi-bin/configManager.cgi?action=setConfig&VideoInMode[0].Config[0]=1
  ```
* **Method:** `GET`

---

## Verification & troubleshooting

### Initial verification

1. Click **Switch to Day/Night now** and confirm the camera changes.
2. Check the camera UI — image/IR/profile should reflect the new mode.
3. Review logs — enable **Log HTTP responses**.
4. Preview schedule — confirm displayed times look correct.

### Common issues

* **401 (Unauthorized)** — wrong credentials or auth type.
* **404 (Not Found)** — wrong endpoint; check spelling/brackets.
* **200 but no change** — auto schedule still active, or parameter mismatch.
* **Network reachability** — ensure Scrypted can reach the camera.

### Debugging steps

1. Replicate with curl/Postman.
2. Check camera logs (if available).
3. Search forums/docs for your model + firmware.
4. Review manufacturer API notes for changes.