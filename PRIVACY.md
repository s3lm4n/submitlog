# Privacy Policy

SubmitLog is designed with privacy as its foundational, non-negotiable principle.

## The Core Guarantee

**All your submission and draft data stays entirely on your local device.**

We believe your application data, answers, and personal thoughts belong to you alone. To guarantee this:

- **No Analytics & No Telemetry:** We do not track your usage, behavior, clicks, or interactions.
- **No Accounts & No Logins:** SubmitLog works immediately without any sign-up or profile creation.
- **No Servers & No Cloud:** There is zero backend infrastructure. No remote servers receive or store your data.
- **No Network Transmission:** The extension never transmits captured form data, drafts, or suggestions over the network.
- **No Third-Party SDKs:** No trackers, no ad networks, no analytics libraries, and no AI/cloud endpoints.

---

## Host Permissions and Page Access Explained

To deliver automatic autosave and reload protection, SubmitLog declares host permissions for:

- `http://*/*`
- `https://*/*`

### Why This Permission Is Required

SubmitLog runs automatically on normal web pages so that whenever you fill out an application or submission form:

1. It automatically arms local autosave without requiring you to open the extension popup or click a site-specific toggle.
2. It safely restores your latest draft into blank fields if the page reloads (F5) or you navigate back.
3. It powers the contextual field assistant (pencil icon) from your previously archived submissions.

### How We Protect Your Privacy With This Access

- **Strict Form Scoping:** SubmitLog does **not** scrape or monitor every input on every webpage. The meaningful-form detector only activates autosave and assistant features when a genuine application, contact, or submission form is scored. Search bars (like Google Search), navigation controls, filter bars, and utility inputs are strictly ignored.
- **No Access to Internal Browser Pages:** SubmitLog cannot and does not access browser-internal pages (`chrome://`, `edge://`, `brave://`, `about:`, or extension pages).
- **All Data Remains Local:** Everything autosaved or captured is written directly to your browser's private IndexedDB on your machine. Zero bytes leave your device.
- **Strict Incognito / Private Browsing Guard:** All autosave, draft restore, capture, and assistant features are strictly disabled in Incognito / Private Browsing windows.

---

## Architecture: Archive vs. Draft Autosave

SubmitLog maintains a strict architectural boundary between two distinct data stores in extension-owned IndexedDB:

### 1. Permanent Archive (`submissions` store)

- Stores explicit user-initiated submission snapshots and intentional updates.
- Records are preserved permanently until you explicitly delete them in the Archive dashboard.
- Powers the searchable archive, Q&A exports (Markdown / JSON), and cross-form answer reuse.
- Autosave draft updates never alter or rewrite archived submissions.

### 2. Draft Autosave (`drafts` store)

- Automatically saves in-progress form drafts continuously as you type, surviving tab close, reload (F5), and browser restart.
- Uses a last-write-wins model where the most recent revision is authoritative per form identity (`origin|pathname|formFingerprint`).
- Stored exclusively in extension-owned storage (never in the visited site's `localStorage` or `sessionStorage`).
- **Separation Guarantee:** Clearing an active draft **never** deletes or alters Archive submissions. Deleting an Archive submission never deletes unrelated active drafts.
- **Retention Policy:** Inactive drafts are automatically pruned after 30 days since their last modification.

---

## Sensitive Field Exclusions

SubmitLog uses a conservative exclusion principle. Sensitive fields are never captured into the Archive, never autosaved into drafts, never restored, and never attached to by the field assistant.

Automatically excluded fields include:

- Passwords (`type="password"`, `autocomplete="current-password"`, `autocomplete="new-password"`)
- One-Time Passwords (OTP) and two-factor authentication codes (`autocomplete="one-time-code"`, `totp`, `mfa`, `auth-code`)
- Credit card numbers, CVV/CVC, expiration dates, and payment tokens (`autocomplete="cc-number"`, `cc-csc`, `cvv`)
- Hidden inputs (`type="hidden"`)
- Authentication tokens and session secrets
- File uploads: only selected file names are noted (file contents are **never** read or stored)

---

## Private / Incognito Browsing Protection

SubmitLog strictly forbids capturing, autosaving, or indexing form data from private or incognito windows:

- Manual capture is completely blocked.
- Automatic autosave listeners and draft storage writes are disabled.
- The field assistant and answer suggestions are disarmed.
- No form data, page title, URL, or metadata is ever written to storage from private sessions.

---

## Cookies and Website Storage

SubmitLog does **not** inspect, read, or modify cookies, session storage, local storage, or authentication tokens of any website you visit.
