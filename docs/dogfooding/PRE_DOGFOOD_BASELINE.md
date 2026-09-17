# SubmitLog — Pre-Dogfood Baseline Report

Generated at: 2026-09-17
Baseline Commit: `32f4b82ff38ace90cea95150acfef4df63f611f8`

---

## 1. System Metadata & Build Baseline

- **Package Name**: `submitlog`
- **Package Version**: `0.1.0`
- **WXT Version**: `0.21.4`
- **Vite Version**: `7.3.6`
- **React Version**: `19.1.0`
- **Git Commit (HEAD)**: `32f4b82ff38ace90cea95150acfef4df63f611f8` (`feat: add support links`)
- **Test Suite Result**: **260 passed** across 23 test suites (0 failures)
- **TypeScript**: Passed (`tsc --noEmit` with zero errors)
- **Linter**: Passed (`eslint .` with zero errors or warnings)
- **Formatter**: Passed (`prettier --check .` with zero style issues)
- **NPM Production Security Audit**: `found 0 vulnerabilities` (`npm audit --omit=dev`)

### Bundle Size Breakdown

#### Chromium (Manifest V3) — Total: 599.31 kB

- `manifest.json`: 710 B
- `archive.html`: 556 B
- `popup.html`: 542 B
- `background.js`: 37.69 kB
- `chunks/archive-dYKGAk7j.js`: 57.29 kB
- `chunks/global-BWwp3r6K.js`: 290.35 kB
- `chunks/popup-CwFEBDhI.js`: 117.28 kB
- `content-scripts/content.js`: 44.79 kB
- `assets/archive-CV7FOwux.css`: 47 B
- `assets/global-mIbh4r12.css`: 43.63 kB
- `assets/popup-CCJS602b.css`: 87 B
- `icons/icon-128.png`: 3.29 kB
- `icons/icon-48.png`: 1.18 kB
- `icons/icon-32.png`: 725 B
- `icons/icon-16.png`: 405 B
- `icons/toolbar-32.png`: 429 B
- `icons/toolbar-16.png`: 314 B

#### Firefox (Manifest V2) — Total: 599.41 kB

- `manifest.json`: 818 B
- `archive.html`: 556 B
- `popup.html`: 542 B
- `background.js`: 37.69 kB
- `chunks/archive-dYKGAk7j.js`: 57.29 kB
- `chunks/global-BWwp3r6K.js`: 290.35 kB
- `chunks/popup-CwFEBDhI.js`: 117.28 kB
- `content-scripts/content.js`: 44.79 kB
- `assets/archive-CV7FOwux.css`: 47 B
- `assets/global-mIbh4r12.css`: 43.63 kB
- `assets/popup-CCJS602b.css`: 87 B
- `icons/icon-128.png`: 3.29 kB
- `icons/icon-48.png`: 1.18 kB
- `icons/icon-32.png`: 725 B
- `icons/icon-16.png`: 405 B
- `icons/toolbar-32.png`: 429 B
- `icons/toolbar-16.png`: 314 B

---

## 2. Manifest & Permission Audit

### Chromium Manifest V3

```json
{
  "manifest_version": 3,
  "name": "SubmitLog",
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "action": {
    "default_title": "SubmitLog",
    "default_icon": { "16": "icons/toolbar-16.png", "32": "icons/toolbar-32.png" },
    "default_popup": "popup.html"
  },
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "all_frames": true,
      "run_at": "document_idle",
      "js": ["content-scripts/content.js"]
    }
  ]
}
```

### Firefox Manifest V2

```json
{
  "manifest_version": 2,
  "name": "SubmitLog",
  "permissions": ["activeTab", "scripting", "storage", "http://*/*", "https://*/*"],
  "browser_action": {
    "default_title": "SubmitLog",
    "default_icon": { "16": "icons/toolbar-16.png", "32": "icons/toolbar-32.png" },
    "default_popup": "popup.html"
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "submitlog@s3lm4n.github.io",
      "data_collection_permissions": { "required": ["none"] }
    }
  },
  "background": { "scripts": ["background.js"] },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "all_frames": true,
      "run_at": "document_idle",
      "js": ["content-scripts/content.js"]
    }
  ]
}
```

### Permission Analysis & Broad-Host Justification

| Permission                                     | Purpose & Requirement Status                                                                                                                                                                                                                                                                                                                                            |
| :--------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                      | **Required**: Stores site disable preferences (`submitlog.disabledSites`) and global pause toggle (`submitlog.globalEnabled`).                                                                                                                                                                                                                                          |
| `http://*/*`, `https://*/*` (host permissions) | **Required**: SubmitLog needs its locally executing content script to run on arbitrary user-visited HTTP and HTTPS pages so it can detect supported form fields, save drafts locally, and provide explicit user-triggered answer reuse. Broad host access enables that cross-site form support. Captured form data is not transmitted to a remote server.               |
| `activeTab`                                    | **Retained**: Standard permission for tab interactions; enables future explicit user-action workflows without requesting persistent tab query privileges.                                                                                                                                                                                                               |
| `scripting`                                    | **Currently Unused at Runtime**: The content script is declaratively injected via manifest `content_scripts`. Dynamic programmatic injection (`browser.scripting.executeScript`) is not currently invoked at runtime. _Recommendation_: Retained during dogfooding to avoid runtime behavioral divergence; can be cleanly removed prior to store publication if unused. |

#### STORE-PREPARATION NOTE

The current `scripting` permission appears unused because SubmitLog uses declaratively registered content scripts. Re-evaluate and likely remove it before store submission, after the dogfooding period.

---

## 3. Product Model & Safety Audit

### A. Auto-Save vs Auto-Restore Contract

- **Auto-Save**: Active across detected application forms. Keystrokes are debounced (300ms) with immediate flushing on `focusout`/`blur` and `change`.
- **Auto-Restore**: **Zero automatic restoration**. Webpages are never modified or pre-filled on load, refresh, history navigation, or route changes.
- **Explicit Restore (Pencil Action)**: The contextual pencil icon appears next to eligible fields **only** when a saved answer exists in Answer Memory. Clicking the pencil immediately fills the field with standard framework-compatible events.

### B. Safety Hierarchy & Precedence

When evaluating whether SubmitLog should operate on a given page, the order of precedence is strictly deterministic:

1. **Global Pause** (`'global_paused'`): When toggled in the popup, immediately disarms all content scripts, disconnects MutationObservers, cancels pending timers, disarms the assistant pencil, and halts autosave writes.
2. **User-Disabled Site** (`'site_disabled'`): Hostname check against `submitlog.disabledSites`. Immediately stops all page activity for that origin.
3. **Built-in Safety Excluded Context** (`'excluded_context'`): Context-aware pattern match preventing accidental activation on non-application pages.
4. **Active** (`'active'`): Scans forms and arms listeners if valid fields exist.

### C. Context Exclusions & Supported Surfaces

- **Search Engines**: Excluded on Google, Bing, DuckDuckGo, Yahoo, Brave, Kagi, Ecosia, and generic `/search` / `/results` paths.
- **AI Chat Assistants**: Excluded on ChatGPT, Claude, Gemini, Copilot, Perplexity, Poe, Mistral, DeepSeek, Groq, Character.AI, Pi, etc.
- **Webmail & Chat**: Excluded on Gmail, Outlook Web, WhatsApp Web, Slack, Discord, Microsoft Teams, Telegram Web, Element, Messenger.
- **Document & Design Editors**: Excluded on Figma, Canva, Miro, Notion, Airtable, Coda, Lucidchart, Google Docs, Sheets, Slides, Drawings.
- **Google Forms Preserved**: `docs.google.com/forms/*` is **explicitly preserved** as a supported application form context.
- **In-Browser IDEs**: Excluded on GitHub Codespaces, Replit, StackBlitz, CodeSandbox, Gitpod, Glitch, CodePen, JSFiddle.
- **Dedicated Auth & Payment**: Excluded on Okta, Auth0, Clerk, Apple ID, Google Accounts, Microsoft Online, and generic `/login`, `/signin`, `/checkout`, `/pay`, `/stripe` routes.

### D. Sensitive Field Exclusion

The following fields are strictly excluded from autosave and assistant attachment:

- Password fields (`type="password"`)
- Hidden inputs (`type="hidden"`)
- Autocomplete values containing `password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`
- Regex patterns matching `password`, `passwd`, `pwd`, `otp`, `totp`, `mfa`, `cvv`, `cvc`, `cardnumber`, `cc-num`, `secret`, `token`, `auth_token`, `ssn`, `social-security`
- File inputs: Only the selected file name string (`"Resume.pdf selected"`) is captured; file contents or byte buffers are **never** read.

#### FILE INPUT PRIVACY CHECK

- Observe whether storing selected filenames provides useful value.
- Filenames may themselves contain personal information.
- Evaluate after dogfooding whether file inputs should be ignored completely before public release.
- Do not change current behavior during baseline freeze.

### E. Data Lifecycle & Deletion Tombstones

- **Draft Identity**: Formed as `${origin}|${pathname}` (or with `${formFamilyKey}`), stripping marketing tracking parameters (`utm_*`, `gclid`, etc.). Multi-step workflows on the same path seamlessly merge into a single draft.
- **Persistent Tombstones**: When a draft is deleted, a tombstone record is persisted in IndexedDB (`draft_tombstones` store with 7-day retention). Any pending or in-flight autosave write from that session is discarded with `deleted_tombstone`. A deleted draft will only recreate if the user makes a genuinely new edit (`clientTimestamp > deletedAt`).
- **Archive Isolation**: Submissions are immutable snapshot records. Deleting a draft does not affect saved submissions.
- **Export**: JSON export allows full local backup of submissions and drafts.

### F. Network & Privacy Audit

- **Outbound HTTP / Fetch**: **0** calls.
- **WebSocket / WebRTC**: **0** calls.
- **sendBeacon / Analytics**: **0** calls.
- **Telemetry / Remote Logging**: **0** calls.
- **External Links**: GitHub and Buy Me a Coffee are user-initiated external hyperlinks with `target="_blank"` and `rel="noopener noreferrer"`. No external scripts or widgets are embedded.

---

## 4. Known Limitations & Edge Cases

1. **Custom Canvas / Shadow DOM Fields**: Forms implemented entirely with closed Shadow DOM or canvas rendering (non-standard HTML inputs) cannot be observed by standard DOM event delegation.
2. **Multi-Tab Simultaneous Editing**: If the same form on the same path is edited concurrently across two open tabs, the latest field update replaces that field key in the shared draft.
3. **Browser Storage Eviction**: Extension storage is local to the browser profile. Clearing extension data or resetting the browser profile wipes IndexedDB unless previously exported as JSON.

---

## 5. Local Git Stash Inventory (Preserved Unaltered)

```text
stash@{0}: On main: svg popup ripple experiment - rejected
stash@{1}: On main: svg popup ripple experiment - rejected
stash@{2}: On main: organic power toggle draft before popup-surface redesign
```

_(All stashes remain untouched on the stash stack)._
