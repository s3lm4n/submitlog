# SubmitLog

> **Never forget what you submitted.**

SubmitLog is a cross-browser, local-first, privacy-first archive for web form submissions and applications.

You fill out a job application, grant proposal, accelerator questionnaire, or scholarship form. SubmitLog captures your questions and answers into a structured local archive that you can search, reuse, and export anytime.

No accounts. No cloud. No telemetry. Your data never leaves your device.

---

## Key Features

- **One-Click Form Capture:** Instant scan and capture from standard forms, modern SPAs (Tally, Google Forms, SmartSimple), and multi-step applications.
- **Silent, Automatic Autosave:** Whenever a meaningful application or submission form is detected on a web page, SubmitLog automatically saves safe edits locally as you type. No popup interaction or manual setup required.
- **Optimized Write Strategy:** Keystrokes debounced locally, immediate persistence on field blur/focusout, and prompt flushes on form submit, tab switch (visibility hidden), and pagehide.
- **Last-Write-Wins Draft Model:** Each form identity (`origin|pathname|formFingerprint`) maintains exactly one authoritative current draft. No confusing version prompts.
- **Explicit One-Click Restore:** SubmitLog never automatically writes saved draft values back into a webpage after reload (F5), navigation, or restart. Saved answers are only inserted when you explicitly click the inline pencil assistant or trigger a fill action.
- **Contextual Field Assistant:** Subtle inline pencil assistant appears next to eligible form fields with saved answers for instant single-click fill, updates, and clipboard copy.
- **Deterministic Form Matching:** Recognizes matching forms by semantic questions and structure, allowing full form fill from prior submissions.
- **Non-Destructive Submission Updates:** Update existing archived submissions or create new snapshots with automatic revision history.
- **Strict Separation of Archive vs. Drafts:** Explicit snapshots in the Archive remain untouched when drafts are edited or cleared.
- **Sensitive Field Guard:** Passwords, OTP/2FA codes, payment card numbers, CVVs, and hidden inputs are strictly excluded.
- **Global Pause & Per-Site Controls:** Pause SubmitLog globally with a single click, or disable it on specific websites. When paused or disabled, all page scanning, autosave listeners, and the assistant immediately stop.
- **Strict Private Browsing Block:** Automatically disables all capture, autosave, and assistant operations in Incognito or Private Browsing windows.
- **Full-Text Local Search & Export:** Search past answers by keyword, question, or domain. Export as Markdown or JSON anytime.

---

## Privacy Philosophy

SubmitLog is built on uncompromising privacy principles:

- **No backend** — all data stays on your local device in extension-owned IndexedDB
- **No accounts or logins** — works out of the box with zero sign-up
- **No telemetry or analytics** — no trackers, no pings, no usage metrics
- **No network transmission** — captured submissions and drafts are never transmitted
- **User-initiated modification only** — saved answers are never written into a page without an explicit user click
- **Global Pause & Site Controls** — pause the extension globally or disable on specific sites; paused/disabled pages are completely unmonitored
- **Strict form scoping & built-in safety exclusions** — only arms on genuine application/submission forms; search engines, AI chatbots, webmail, and editor surfaces are rejected
- **30-day draft retention** — in-progress drafts older than 30 days are automatically cleaned up

See [PRIVACY.md](./PRIVACY.md) for full privacy architecture details.

---

## Permissions

SubmitLog requests host access for `http://*/*` and `https://*/*` in order to automatically detect meaningful forms, persist drafts locally as you type, and power the contextual field assistant for explicit one-click answer restoration.

- **Chromium (MV3):** Declared via `host_permissions: ["http://*/*", "https://*/*"]`
- **Firefox (MV2):** Declared via `permissions: ["activeTab", "scripting", "storage", "http://*/*", "https://*/*"]`

All form inspection and draft saves happen exclusively on your device. Zero bytes are ever transmitted over the network.

---

## Supported Browsers

- Google Chrome (Manifest V3)
- Microsoft Edge
- Brave
- Other Chromium-based browsers
- Mozilla Firefox (Manifest V2 / Gecko target)

---

## Development Setup

### Prerequisites

- Node.js >= 22
- npm

### Installation

```bash
git clone https://github.com/s3lm4n/submitlog.git
cd submitlog
npm install
```

### Development Commands

| Command                 | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `npm run dev`           | Start Chromium dev server with hot reload            |
| `npm run dev:firefox`   | Start Firefox dev server with hot reload             |
| `npm run build`         | Production build for Chromium (`.output/chrome-mv3`) |
| `npm run build:firefox` | Production build for Firefox (`.output/firefox-mv2`) |
| `npm run test`          | Run Vitest test suite                                |
| `npm run lint`          | Run ESLint checks                                    |
| `npm run typecheck`     | Run TypeScript compiler type checking                |
| `npm run format:check`  | Verify code formatting with Prettier                 |
| `npm run format`        | Format all code with Prettier                        |

---

## Loading the Extension

### Chromium (Chrome / Edge / Brave)

1. Run `npm run build`
2. Navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `.output/chrome-mv3` folder

### Firefox

1. Run `npm run build:firefox`
2. Navigate to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on...**
4. Select `manifest.json` inside the `.output/firefox-mv2` folder

---

## Architecture

| Layer       | Technology                                                    |
| ----------- | ------------------------------------------------------------- |
| Framework   | [WXT](https://wxt.dev)                                        |
| UI          | React 19                                                      |
| Language    | TypeScript (Strict Mode)                                      |
| Storage     | Extension-owned IndexedDB (`submissions` and `drafts` stores) |
| Permissions | `activeTab`, `scripting`, `storage`, host permissions         |
| Testing     | Vitest + happy-dom                                            |
| Formatting  | Prettier + ESLint                                             |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contributor guidance and coding standards.

## License

MIT License — see [LICENSE](./LICENSE).

Copyright (c) 2026 Selman Ali Dokumaci
