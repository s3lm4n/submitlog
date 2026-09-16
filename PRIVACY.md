# Privacy Policy

SubmitLog is designed with privacy as its core principle.

## The Core Guarantee

**All your submission data stays entirely on your device.**

We believe that your data is yours alone. To ensure this:

- **No Analytics & No Telemetry:** We do not track your usage, behavior, or interactions.
- **No Accounts & No Logins:** SubmitLog works out of the box without requiring you to sign up.
- **No Servers & No Cloud:** There is no backend infrastructure where your data is sent or stored.
- **No Data Transmission:** The extension does not transmit captured data over the network.

## Permissions Explained

SubmitLog requires the following minimal permissions to function:

- **`activeTab`**: Allows the extension to read the current page's content _only_ when you explicitly click the extension icon. It does not monitor all tabs in the background.
- **`scripting`**: Required to inject the script that captures form data from the active tab when requested.
- **`storage`**: Used to store small application preferences (like theme or settings) locally in your browser. Form data is stored in the browser's built-in IndexedDB.

## What We Exclude

To protect your sensitive information, SubmitLog specifically avoids capturing certain fields. We use a conservative exclusion principle.
Excluded fields include, but are not limited to:

- Passwords (`type="password"`)
- One-Time Passwords (OTP) and verification codes
- Credit card numbers, CVV, and payment details
- Hidden fields (`type="hidden"`)

## File Uploads

SubmitLog does **not** capture or store the contents of files uploaded through web forms. Only metadata (such as the file name) may be stored for reference.

## Cookies and Local Storage

SubmitLog does not access, read, or modify your cookies, `localStorage`, `sessionStorage`, or authentication tokens.

## Private / Incognito Browsing Protection

SubmitLog strictly forbids archiving forms from private or incognito windows. When invoked on a private browsing tab:

- Form capture is blocked entirely.
- No submission data, page title, URL, or form metadata is collected or stored.
- A neutral notice is displayed informing the user that private sessions are not archived.

## Browser-Protected Pages

SubmitLog does not execute on internal browser pages (`chrome://`, `about:`, `edge://`), extension pages, or system contexts.
