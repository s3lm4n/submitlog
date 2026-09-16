# Security

## Responsible Disclosure

If you discover a security vulnerability in SubmitLog, please do **NOT** open a public GitHub issue.
Currently, SubmitLog is in active early development. A private disclosure channel will be established before public release. Until then, please hold any sensitive security reports.

## High-Level Threat Model

- **Local Storage:** SubmitLog stores data entirely in the browser's IndexedDB. This means the data is protected by the browser's own security model and same-origin policy limitations for extensions. If the device or browser profile is compromised, the stored data may be compromised.
- **No Network Transmission:** Captured data is never transmitted over the network by the extension itself. There is no remote attack surface regarding data transit.
- **Explicit Capture:** The extension only captures data when explicitly invoked by the user. It does not passively monitor or log keystrokes.
- **Content Script Execution:** The content script responsible for reading form data only runs when the user invokes the extension on the active tab.

## Conservative Exclusion Principle

We employ a conservative exclusion principle: when in doubt about the sensitivity of a field, we do not capture it.

### Sensitive Field Exclusion List

SubmitLog explicitly ignores and excludes the following types of fields from capture:

- Passwords (e.g., `type="password"`)
- Authentication tokens and One-Time Passwords (e.g., `autocomplete="one-time-code"`)
- Payment information (e.g., credit card numbers, CVVs, expiry dates, `autocomplete="cc-number"`, `autocomplete="cc-csc"`)
- Hidden inputs (`type="hidden"`)

## What SubmitLog Does NOT Access

- Cookies
- `localStorage` and `sessionStorage` of websites you visit
- File contents of file input fields
- Browsing history
- Form inputs in private / incognito browsing sessions (capture is blocked)
- Browser-internal and privileged system pages (`chrome://`, `about:`, `edge://`)
