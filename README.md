# Day/Night Switcher (Scrypted Plugin)

Automatically switch each camera to your preferred **Day** or **Night** profile at sunrise and sunset.
Works with cameras that expose HTTP endpoints (Hikvision, Dahua, Amcrest, EmpireTech, etc.).

* **Per-camera control** with global defaults
* **Offsets** around sunrise/sunset (e.g. switch 10 min after sunset)
* **Manual run** buttons (*Switch to Day/Night now*)
* **Retries & backoff** for reliability
* **Digest / Basic / None** authentication
* **Schedule preview** with local time and time zone

## Quick Start

1. **Disable your camera's built-in day/night schedule** (set it to *Manual/Fixed/Full Time*).
2. In the plugin's **Global settings**, enter your **Latitude/Longitude**. On desktop, right-click anywhere on Google Maps to show the coordinates. On mobile, long-press to drop a pin, then swipe up to copy them.
3. For each camera, open **Day/Night Switcher** settings, configure the Day and Night requests, and enable switching.

## How it works

1. Each day, the plugin calculates **sunrise and sunset times** based on your latitude and longitude, applying any configured offsets.
2. At those scheduled times, it sends the configured **HTTP request** using the URL and method you entered.
3. Requests can include authentication (Digest, Basic, or None), headers, and an optional body. Retries with increasing delays are supported for reliability.
4. The plugin recalculates the schedule every hour and displays the next switch times in your local time zone.

## Installation

1. Install the plugin in Scrypted.
2. In **Global settings**, configure **Latitude** and **Longitude** (and optionally **Time zone**).
3. For each camera, configure Day/Night actions and enable switching.

## Camera setup

Before configuring the plugin, prevent the camera's own schedule or auto logic from conflicting with your commands:

1. **Disable automatic day/night switching** in the camera's web UI. Look for **Profile Schedule**, **Day/Night Mode**, **Scene Mode**, etc., and set it to *Manual/Fixed/Full Time*.
2. **Prepare the profiles/scenes** you want the plugin to trigger, such as a "Day" profile and a "Night" profile.
3. **Apply and reboot** if required by your camera's UI.

You will also need the correct **HTTP endpoints** for your model and firmware:

* Check the manufacturer's API documentation or community forums.
* Useful search terms: `<brand> <model> http api`, `ISAPI`, `configManager.cgi`, `cgi day night`, `profile switch`.
* Test each request with curl or Postman, then copy the URL, method, headers, and body into the plugin.

## Global settings

* **Latitude / Longitude:** Decimal degrees, for example `51.507351, -0.127758`.
* **Time zone (optional):** Standard time zone ID, for example `Europe/London`. This only controls how times are displayed. Switching is based on sunrise and sunset at the configured coordinates.
* **Use 24-hour time:** UI display preference.
* **Sync phase on startup:** Sends the expected Day/Night action once when the camera mixin starts or switching is enabled.
* **Sunrise / Sunset offset (mins, default):** Defaults for all cameras and can be overridden per camera.
* **Reliability defaults:**

  * **HTTP total attempts:** Total tries including the first attempt. `1` disables retries; the maximum is `10`.
  * **Retry base delay (ms):** Base delay between retries. The maximum is `60000` ms.
  * **Log HTTP responses:** Log the status and a capped response body.

## Per-camera settings

* **Enable Day/Night switching:** Master on/off.
* **Override location and time:** Per-camera latitude, longitude, and time settings.
* **Override sunrise/sunset offsets:** Per-camera offsets in minutes. Positive values run after the event and negative values run before it.
* **Override startup sync:** Choose whether this camera follows the global startup sync setting or uses its own setting.
* **Authentication**:

  * **Auth Type:** `digest`, `basic`, or `none`.
  * **Username / Password:** Used by the plugin. Do not embed credentials in URLs.
* **Day / Night actions**:

  * **URL:** Camera endpoint that triggers the mode.
  * **Method:** `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
  * **Content-Type:** Used when sending a request body.
  * **Extra Headers (JSON):** For example, `{"Accept":"application/xml"}`.
  * **Body:** Optional request body for POST, PUT, PATCH, or DELETE.
* **Reliability and Logging (per camera):** Override the global retry, backoff, and logging settings.
* **Tools (General tab)**:

  * **Schedule preview:** Shows the next switch times, configuration summary, and last successful action.
  * **Switch to Day/Night now:** Runs an action immediately for testing.

## Scheduling details

* The plugin maintains two scheduled events: **Sunrise to Day** and **Sunset to Night**.
* These times are recalculated hourly (with offsets applied).
* After each event runs, the schedule is refreshed to ensure accuracy.
* Hourly checks detect a calculated phase change even if the original transition timer was cleared or delayed.
* If a scheduled action exhausts its configured attempts, the plugin retries the expected phase during hourly schedule checks until it succeeds or the expected phase changes.
* Manual action failures do not create a pending reconciliation.
* Obsolete queued automatic actions are cancelled when switching is disabled or the expected phase changes.
* A separate guard timer re-checks long-running sessions every 3 hours. Startup initialization handles plugin and server restarts.
* Pending reconciliation is held in memory. Startup sync normally restores the expected phase after a restart; if startup sync is disabled, an earlier pending retry is not resumed.

## Configuration examples (tested models)

The following examples have been confirmed on specific models and firmware versions.
Other cameras may offer different options or use different endpoints.

### Hikvision (ISAPI profile switching)

Confirmed models:

* DS-2CD2347G2H-LIU (Firmware V5.7.23 build 260320)
* DS-2CD2387G2H-LIU (Firmware V5.7.23 build 260320)

**What it does:**
Switches the camera into one of its Scene Modes (for example: custom1, custom2, basic, or low illumination).

**Before you use the plugin:**
In the Hikvision web UI, open *Configuration > Image > Display Settings > Scene Mode*:

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

### Dahua / Amcrest / EmpireTech

The models below use Dahua-compatible `configManager.cgi` endpoints. The required parameters vary by model and firmware.

#### Day/Night profiles with VideoInMode

Confirmed models:

* Dahua IPC-HDW5442TM-AS (Firmware V2.840.0000000.30.R, Build Date: 2025-02-27)

**What it does:**
Toggles the **Day/Night mode setting** to *Day (0)* or *Night (1)*, applying the profile configured for each.

**Before you use the plugin:**
In the Dahua web UI, open *Setup > Camera > Conditions > Day/Night*. Confirm that you can manually set Day and Night profiles and disable automatic switching.

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

#### Customized Scene with VideoInOptions

Confirmed models:

* EmpireTech IPC-T54IR-ZEB-S3 (Firmware V3.142.0000000.12.R, Build Date: 2026-04-27)

**What it does:**
Each request changes two settings. It selects the configured **Day** or **Night** image options and sets the camera's color behavior.

**Before you use the plugin:**
Set the camera's working mode to **Customized Scene**, then configure the Day and Night profiles as required.

**URL options:**

* `action=setConfig` writes the supplied values to the camera configuration.
* `VideoInOptions[]` targets the camera's video input options. A multi-channel device may require a channel number inside the brackets.

`NightOptions.SwitchMode` selects which image options the camera uses:

These values are defined by the compatible CGI API. Availability can vary by model and firmware.

| Value | Behavior |
| --- | --- |
| `0` | Always use the Day image options |
| `1` | Switch based on brightness |
| `2` | Switch using the camera's internal time schedule |
| `3` | Always use the Night image options |
| `4` | Always use the Normal image options |

`NightOptions.DayNightColor` controls color mode separately:

| Value | Behavior |
| --- | --- |
| `0` | Always use color |
| `1` | Select color or monochrome based on brightness |
| `2` | Always use monochrome |

**Day Action (UI fields):**

* **URL:**

  ```
  http://CAMERA_IP/cgi-bin/configManager.cgi?action=setConfig&VideoInOptions[].NightOptions.SwitchMode=0&VideoInOptions[].NightOptions.DayNightColor=0
  ```
* **Method:** `GET`
* **Result:** Uses the Day image options and forces color mode.

**Night Action (UI fields):**

* **URL:**

  ```
  http://CAMERA_IP/cgi-bin/configManager.cgi?action=setConfig&VideoInOptions[].NightOptions.SwitchMode=3&VideoInOptions[].NightOptions.DayNightColor=2
  ```
* **Method:** `GET`
* **Result:** Uses the Night image options and forces monochrome mode.

## Security

* Use HTTPS camera endpoints where the camera firmware supports them.
* Use a dedicated camera account with only the permissions required to change image settings.
* Camera credentials are stored in Scrypted settings. Protect access to the Scrypted server and its backups.
* HTTP response logging may capture sensitive camera data. Enable it only while troubleshooting.

## Verification and troubleshooting

### Initial verification

1. Click **Switch to Day/Night now** and confirm the camera changes.
2. Check the camera UI. The image, IR state, or profile should reflect the new mode.
3. Enable **Log HTTP responses** and review the plugin logs.
4. Preview the schedule and confirm the displayed times.

### Common issues

* **401 (Unauthorized):** Check the credentials and authentication type.
* **404 (Not Found):** Check the endpoint path and parameters.
* **200 but no change:** The camera's automatic schedule may still be active, or the request parameters may be wrong.
* **Scheduled action failed:** The configured request attempts run first. If they all fail, hourly reconciliation continues while that phase is still expected.
* **Network reachability:** Ensure Scrypted can reach the camera.

### Debugging steps

1. Replicate with curl/Postman.
2. Check camera logs (if available).
3. Search forums/docs for your model + firmware.
4. Review manufacturer API notes for changes.
