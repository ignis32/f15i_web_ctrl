# F15i Web Controller

**Live app: https://ignis32.github.io/f15i_web_ctrl/**

An unofficial browser-based controller for the **Mooer F15i** smart amp, built using the Web Bluetooth API.

## Requirements

- Chrome or Edge (Web Bluetooth is not supported in Firefox or Safari)
- On **Android**, Chrome has Web Bluetooth enabled by default — no extra steps needed
- On **desktop Chrome**, Web Bluetooth may need to be explicitly enabled: go to `chrome://flags/#enable-web-bluetooth` and set it to **Enabled**, then relaunch Chrome
- HTTPS connection (required by Web Bluetooth — use the hosted version or run locally with `npm run dev`)
- A Mooer F15i amp with Bluetooth enabled

## Usage

1. Open the app in Chrome or Edge
2. Click **Connect** and select your F15i from the device list
3. The current preset loads automatically — browse presets, edit effects and parameters, manage MNRS amp/cab slots

## Disclaimer

This app is **unofficial and unaffiliated with Mooer**. It was created by observing Bluetooth LE traffic between the official Mooer app and the hardware. No Mooer source code or proprietary assets were used.

**Use at your own risk.** Sending wrong commands over BLE can freeze the amp or cause unexpected behaviour. The app has been tested against firmware **v1.2.0** — other firmware versions may behave differently. Some edge cases (particularly around effect slot management) have been known to freeze the amp, requiring a power cycle or factory reset to recover. **If you are not comfortable with the risk of losing your hardware, stick to the official Mooer app.**

This is a personal hobby project — the official Mooer app is mobile-only, and I wanted to be able to configure the amp from a desktop. It does not interact with Mooer's cloud services — as a result, downloading presets or MNRS preamp/cab files from the Mooer cloud is not supported. To load MNRS files, upload them directly from your local filesystem using the MNRS manager in the app.

AI (Claude Code) had been heavily used during development of this app. Therefore, regardless of my efforts, app might contain stupid errors leading to breaking your smart amp device.

## Running locally

```bash
npm install
npm run dev
```
