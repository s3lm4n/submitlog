# SubmitLog — Pre-Dogfood Baseline Report (V2)

Generated at: 2026-09-17  
Application Baseline Commit: `688b424950e71d44ca804db59d3ca6defe3d5161`  
Short SHA: `688b424`  
Commit Message: `fix: harden sensitive data handling and answer matching`

---

## 1. System Metadata & Technical Build Baseline

- **Package Name**: `submitlog`
- **Package Version**: `0.1.0`
- **WXT Version**: `0.21.4`
- **Vite Version**: `7.3.6`
- **React Version**: `19.1.0`
- **Git Commit (HEAD)**: `688b424950e71d44ca804db59d3ca6defe3d5161`
- **Short SHA**: `688b424`
- **Commit**: `fix: harden sensitive data handling and answer matching`
- **Test Suite Result**: **426 passed** across 24 test files (0 failed, 0 skipped)
- **TypeScript**: Passed (`tsc --noEmit` with 0 errors)
- **Linter**: Passed (`eslint .` with 0 warnings, 0 errors)
- **Formatter**: Passed (`prettier --check .` with zero style issues)
- **Production Audit (`npm audit --omit=dev`)**: **0 vulnerabilities**
- **Dev Audit (`npm audit`)**: **3 dev-only vulnerabilities**
  - 2 moderate vulnerabilities in Vitest / `@vitest/mocker`
  - 1 critical vulnerability in `happy-dom`
  - _Note_: These dev-only test dependencies are strictly scoped to the test runner and are **not bundled** into production extension builds.

### Bundle Size Breakdown

#### Chromium (Manifest V3) — Total: 608.14 kB

- `manifest.json`: 710 B
- `archive.html`: 556 B
- `popup.html`: 542 B
- `background.js`: 40.75 kB
- `chunks/archive-l5HxB3Hd.js`: 57.29 kB
- `chunks/global-BzsSlJ9_.js`: 292.32 kB
- `chunks/popup-CGosq9Ci.js`: 119.45 kB
- `content-scripts/content.js`: 46.43 kB
- `assets/archive-CV7FOwux.css`: 47 B
- `assets/global-mIbh4r12.css`: 43.63 kB
- `assets/popup-CCJS602b.css`: 87 B
- `icons/icon-128.png`: 3.29 kB
- `icons/icon-48.png`: 1.18 kB
- `icons/icon-32.png`: 725 B
- `icons/icon-16.png`: 405 B
- `icons/toolbar-32.png`: 429 B
- `icons/toolbar-16.png`: 314 B

#### Firefox (Manifest V2) — Total: 608.25 kB

- `manifest.json`: 818 B
- `archive.html`: 556 B
- `popup.html`: 542 B
- `background.js`: 40.75 kB
- `chunks/archive-l5HxB3Hd.js`: 57.29 kB
- `chunks/global-BzsSlJ9_.js`: 292.32 kB
- `chunks/popup-CGosq9Ci.js`: 119.45 kB
- `content-scripts/content.js`: 46.43 kB
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

## 2. Verified Security & Correctness State

Prior to initiating the 7-day personal dogfooding period, SubmitLog underwent two independent adversarial security and correctness audits followed by a comprehensive remediation pass. The resulting implementation was subjected to an independent commit gate review and verified.

### A. Sensitive Data Defense-in-Depth

The following field categories and identifiers are strictly excluded from autosave, answer memory, and archive persistence:

- **Passwords & Authentication**: `password`, `passwd`, `pwd`, `passcode`, `secret`, `auth_token`, security tokens
- **OTP & 2FA**: `otp`, `totp`, `mfa`, `one-time-code`, `security_code`
- **Payment & Card Fields**: `card_number`, `cc-number`, `cc-csc`, `cc-exp`, `cvv`, `cvc`
- **Banking Identifiers**: Bank account numbers, bank routing numbers (`ABA routing`, `bank_routing`, `routing_number`), `IBAN`, `SWIFT` / `BIC` banking identifiers
- **Tax & Government Identifiers**:
  - `SSN` / Social Security Number
  - `TIN` / Taxpayer Identification Number
  - `EIN` / Employer Identification Number
  - `National ID` / National Identity Number / National Insurance Number
  - Passport numbers
  - Driver's license numbers and identifiers
- **Date of Birth**: `DOB`, `date_of_birth`, `birth_date`
- **Compact Alphanumeric Identifiers**: Boundary patterns accurately match compact identifiers (e.g., `dob1`, `dob1990`, `ein123`) without falsely matching regular vocabulary words (e.g., `Einstein`, `continue`, `adobe_illustrator`, `tin_can`).
- **File Inputs**: `input[type="file"]` elements are completely excluded from discovery, capture, autosave, memory suggestions, and persistence. **No filename or file metadata is persisted**.

### B. Two-Tier Defense Architecture

1. **Client-Side Rejection**: Content scripts evaluate fields against sensitive patterns upon scanning and typing, dropping sensitive fields before IPC transmission.
2. **Background Persistence Backstop**: The background autosave handler (`AutosaveHandler`) independently evaluates all incoming fields against the canonical sensitivity filter. Even if a content script is compromised, bypassed, or out of sync, any sensitive field payload is rejected with `status: 'skipped'`. Zero sensitive data reaches persistent storage.

---

## 3. Sensitive Policy Architecture

SubmitLog maintains a unified, centralized policy for sensitive patterns to prevent logic drift:

- **Canonical Policy Source**: `src/security/sensitive-patterns.ts`
- **Direct Canonical Imports**:
  - `src/capture/sensitive-filter.ts`
  - `src/background/autosave-handler.ts`
  - `src/capture/injected-autosave.ts`
  - `src/assistant/injected-assistant.ts`
- **Serialized Self-Contained Copies**:
  - `src/capture/injected-capture.ts`
  - `src/capture/injected-fill.ts`

**Rationale for Inlined Copies**:  
The functions in `injected-capture.ts` and `injected-fill.ts` are dynamically injected into arbitrary target tabs via `browser.scripting.executeScript({ func: ... })`. The browser's script execution serialization mechanism requires functions passed to `func` to be strictly self-contained without closure dependencies or runtime module imports.

**Parity Enforcement**:  
Automated tests in `tests/production-defects-regression.test.ts` enforce byte-level synchronization and regex equality between the canonical policy and the inlined serialized copies on every build.

---

## 4. Answer Memory Baseline

SubmitLog's Answer Memory provides contextual, user-triggered suggestions based on previously submitted forms.

### A. Core Operating Principles

- **AUTO-FILL = Explicit User Action Only**: SubmitLog never automatically inserts values into web fields. The assistant indicator only appears when high-confidence stored answers match the active field, and filling requires an explicit click on the pencil icon.
- **No Broad Bidirectional Substring Matching**: Fuzzy substring matching is strictly prohibited to prevent dangerous false suggestions.
- **Conservative Semantic Base Matching**: Common benign descriptor suffixes/prefixes (`URL`, `Link`, `Profile`, `Number`, `Name`, `Address`) can be normalized when a non-empty semantic base remains (e.g., `GitHub URL` ↔ `GitHub Profile`). Standalone words like `Name` or `Address` retain their full content identity and will not match compound labels (`Company Name`, `Email Address`).

### B. Verified Reusable Label Mappings (Positive Matches)

The following real-world label variations are verified to match reliably:

- `GitHub` ↔ `GitHub URL`
- `GitHub` ↔ `GitHub profile URL`
- `LinkedIn` ↔ `LinkedIn URL`
- `Portfolio` ↔ `Portfolio URL`
- `Phone` ↔ `Phone number`
- `Email` ↔ `Email Address`
- `Company` ↔ `Company Name`
- Question-style wrappers: `"What is your phone number?"` ↔ `"Phone number"`, `"Please provide your cover letter"` ↔ `"Cover Letter"`

### C. Blocked Semantic Collisions (Negative Match Boundaries)

The following label pairs are explicitly blocked from matching:

- `Portfolio` ↔ `Portfolio password` (modifier conflict: `password`)
- `Salary` ↔ `Expected salary` (modifier conflict: `expected`)
- `Salary` ↔ `Current salary` (modifier conflict: `current`)
- `Employer` ↔ `Previous employer` (modifier conflict: `previous`)
- `Employer` ↔ `Current employer` (modifier conflict: `current`)
- `Email` ↔ `Confirm email` (modifier conflict: `confirm`)
- `terminated` ↔ `promoted` (semantic antonyms)
- `position` ↔ `company` (distinct semantic entities)

---

## 5. Delete & Tombstone Lifecycle Baseline

- **Delete → Blur/Focusout Safety**: Deleting a draft from the Archive or popup sets an active tombstone and marks `isDraftDeleted = true`. Subsequent `focusout` or `blur` events explicitly set `isUserEdit: false`, guaranteeing that leaving an open form will **NOT** recreate or resurrect the deleted draft.
- **Genuine User Re-creation**: A deleted draft can only be recreated if the user performs a genuine post-delete edit (`input`, `change`), generating a new client timestamp (`clientTimestamp > deletedAt`).
- **Background Tombstone Rejection**: Any stale in-flight autosave message dispatched prior to draft deletion is discarded by the background handler upon arrival.

---

## 6. Draft Identity Baseline

- **Normalization**: Form paths are canonicalized so that trailing slashes do not bifurcate draft identities (`/apply` and `/apply/` map to the same draft identity).
- **Route Isolation**: Hash-based single-page application routes with distinct workflows (e.g., `/#/contact` vs `/#/jobs/55/apply`) remain isolated into separate drafts.
- **Deterministic Identity**: SubmitLog does not use dynamic full-field fingerprints as the primary draft identity, preventing form revisions or dynamic field additions from silently orphaning active drafts.

---

## 7. Known Dogfooding Observation — Hash Multi-Step Forms (P3)

**Observation**:  
Multi-step application forms that route steps via URL hash fragments (e.g., `/#/apply/step-1`, `/#/apply/step-2`, `/#/apply/step-3`) will currently generate distinct drafts for each step.

**Policy for Dogfooding**:

- Do **NOT** attempt to fix or merge hash steps prior to dogfooding.
- In real-world personal use, observe whether hash-routed multi-step forms are common and whether separate drafts per step materially impair workflow continuity.
- Avoid premature heuristics that risk unintentionally merging separate, unrelated workflows on the same site.

---

## 8. Auto-Save vs. Auto-Restore Contract

SubmitLog adheres strictly to the unidirectional persistence guarantee:

```text
==================================================
AUTO-SAVE    = YES
AUTO-RESTORE = NO
==================================================
```

- **Zero Automatic Webpage Mutation**: Under no circumstance does SubmitLog inject, fill, or restore saved values on:
  - Initial page load
  - Manual page refresh (F5 / Ctrl+R)
  - Browser restart or profile restoration
  - Single-page application (SPA) client routing
  - Browser history navigation (Back / Forward)
- **Explicit Action Only**: Saved values enter form fields only when the user explicitly clicks the contextual Answer Memory assistant action.

---

## 9. Privacy, Permissions & Network Baseline

### A. Zero-Egress Network Guarantee

SubmitLog enforces an absolute local-first architecture with zero external data transmission:

- **0** `fetch()` calls transmitting captured form data
- **0** `XMLHttpRequest` calls
- **0** `WebSocket` connections
- **0** `navigator.sendBeacon()` calls
- **0** Remote telemetry or logging endpoints
- **0** AI cloud services or remote APIs
- **0** Backend servers or cloud accounts
- External links (GitHub repository, Buy Me a Coffee) are plain external hyperlinks with `target="_blank"` and `rel="noopener noreferrer"`. No external tracking scripts, iframes, or widgets are embedded.

### B. Manifest Permissions

#### Chromium (Manifest V3)

```json
{
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["http://*/*", "https://*/*"]
}
```

#### Firefox (Manifest V2)

```json
{
  "permissions": ["activeTab", "scripting", "storage", "http://*/*", "https://*/*"]
}
```

#### STORE-PREPARATION NOTE

The `scripting` permission appears unnecessary for declarative content script operation and should be reassessed for removal prior to public store submission. **Retain it during dogfooding** to maintain parity across environments.
