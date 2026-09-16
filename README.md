# SubmitLog

> **Never forget what you submitted.**

SubmitLog is a cross-browser, local-first, privacy-first archive for web form submissions.

You fill out a job application, grant form, accelerator application, or scholarship form. Before submitting, you click the SubmitLog extension to capture the questions and your answers. SubmitLog stores a structured local snapshot that you can browse, search, and export later.

No account. No backend. No data leaves your device.

## Privacy Philosophy

SubmitLog is built on strict privacy principles:

- **No backend** — all data stays on your local device in the browser's IndexedDB
- **No accounts or login** — nothing to sign up for
- **No telemetry or analytics** — we don't track usage
- **No network requests** — captured data is never transmitted
- **Sensitive field exclusion** — passwords, OTP codes, payment details, and hidden fields are automatically excluded from capture
- **Explicit capture only** — the extension cannot read a page until you invoke it

See [PRIVACY.md](./PRIVACY.md) for the full privacy architecture.

## Supported Browsers

- Google Chrome
- Microsoft Edge
- Brave
- Other Chromium-based browsers
- Mozilla Firefox

## Current MVP Capabilities (v0.1)

- Explicit one-click form capture from any web page
- Intelligent label/question extraction (label, aria, placeholder, fallback)
- Automatic sensitive field detection and exclusion
- Preview and field selection before saving
- Local archive with search across titles, hostnames, questions, and answers
- Individual submission detail view with Q&A display
- Edit submission titles
- Copy individual answers or all answers as Markdown
- Export submissions as JSON or Markdown
- Export entire archive as JSON
- Delete submissions with confirmation
- Light and dark theme (follows system preference)
- Cross-browser support (Chromium + Firefox from a single codebase)

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

| Command                 | Description                               |
| ----------------------- | ----------------------------------------- |
| `npm run dev`           | Start Chromium dev server with hot reload |
| `npm run dev:firefox`   | Start Firefox dev server with hot reload  |
| `npm run build`         | Production build for Chromium             |
| `npm run build:firefox` | Production build for Firefox              |
| `npm run test`          | Run unit tests                            |
| `npm run lint`          | Run ESLint                                |
| `npm run typecheck`     | Run TypeScript type checking              |
| `npm run format`        | Format code with Prettier                 |

### Loading the Extension

**Chromium (Chrome/Edge/Brave):**

1. Run `npm run build`
2. Open `chrome://extensions` (or equivalent)
3. Enable "Developer mode"
4. Click "Load unpacked" and select `.output/chrome-mv3`

**Firefox:**

1. Run `npm run build:firefox`
2. Open `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select any file in `.output/firefox-mv2`

## Architecture

| Layer     | Technology                                                |
| --------- | --------------------------------------------------------- |
| Framework | [WXT](https://wxt.dev)                                    |
| UI        | React 19                                                  |
| Language  | TypeScript (strict mode)                                  |
| Storage   | IndexedDB via [idb](https://github.com/jakearchibald/idb) |
| Testing   | Vitest + happy-dom                                        |
| Linting   | ESLint + Prettier                                         |

## Project Structure

```
submitlog/
├── entrypoints/           # WXT entrypoints
│   ├── popup/             # Extension popup UI
│   ├── archive/           # Full-page archive dashboard
│   └── styles/            # Shared CSS
├── src/
│   ├── models/            # TypeScript data models
│   ├── capture/           # Form discovery, label extraction, sensitive filter
│   ├── storage/           # IndexedDB repository
│   ├── export/            # JSON and Markdown export
│   └── utils/             # Shared utilities
├── tests/
│   ├── fixtures/          # HTML test fixtures
│   └── *.test.ts          # Unit tests
├── wxt.config.ts          # WXT configuration
├── PRIVACY.md             # Privacy architecture
├── SECURITY.md            # Security documentation
└── CONTRIBUTING.md        # Contributor guide
```

## Permissions

SubmitLog requests only the minimum permissions necessary:

- **activeTab** — read the current page only when the user clicks the extension
- **scripting** — inject the capture script into the active tab
- **storage** — store small application preferences locally

The extension does **not** request `<all_urls>` or persistent host permissions.

## Current Limitations

- Manual capture only (no automatic submission detection)
- Basic support for standard HTML form controls; advanced rich-text editors may not be fully captured
- File inputs capture filenames only, never file contents
- No encrypted backup/restore yet
- No browser store distribution yet

## Roadmap

Future possibilities (not yet implemented):

- Opt-in capture-on-submit for selected domains
- Encrypted local backup and restore
- Import/export archive
- Answer reuse and comparison
- Richer form framework adapters

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup instructions and standards.

## License

MIT License — see [LICENSE](./LICENSE).

Copyright (c) 2026 Selman Ali Dokumaci
