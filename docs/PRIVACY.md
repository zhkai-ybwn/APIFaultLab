# APIFaultLab Privacy Policy

[简体中文](隐私说明.md) · English

*Last updated: 2026-11-25*

APIFaultLab is a local-only Chrome DevTools extension for testing how web pages handle API failures, empty states, delays, and retries. It does not operate any remote servers, analytics, telemetry, or third-party tracking.

## 1. Data Accessed Locally

When you explicitly connect APIFaultLab to a web page under test, the extension inspects the following data solely within your browser:

- **Page and request metadata**: Page URLs, HTTP methods, request origins/paths, and request outcome summaries (status code, content type, and hit counts) to discover endpoints, group requests by page, and display rule hits.
- **Selective request matching**: When you configure a query parameter, request header, or JSON body condition on an active rule, APIFaultLab evaluates only the relevant fields of candidate requests directly inside the inspected page.
- **On-demand response sampling**: Response bodies are read only when you explicitly click **Sample response** and only for the matching real response during the 20-second sampling window. Captured samples stay in session memory and are not persisted across browser restarts.

## 2. Local Storage

All persisted configuration stays inside your local Chrome profile:

- **`chrome.storage.local`**: Saved test plans, imported OpenAPI/Swagger or APIFaultLab endpoint catalogs, per-site ignore rules, per-site route grouping preferences, and custom response scenarios.
- **`chrome.storage.session`**: Active per-tab session rules and bounded request summaries used to restore rules across same-origin reloads and extension Service Worker restarts.
- **Page `sessionStorage`**: When startup protection is enabled for an authorized site, a single random session marker is stored in the inspected page's `sessionStorage` so early requests wait for rule confirmation on reload.

## 3. No Remote Transmission or Third-Party Sharing

- APIFaultLab **never transmits, uploads, sells, or shares** your browsing history, API requests, response bodies, rules, or settings with any external server or third party.
- Document imports (OpenAPI 3.0/3.1, Swagger 2.0, or APIFaultLab catalog JSON) are parsed locally in an isolated Web Worker. External `$ref` URLs are skipped and never fetched over the network.
- Any export file (JSON backup, plan summary/full plan, or storage rescue export) is created only when you click download and is saved directly to your device. Review exported full plans, backups, or imported examples before sharing them with others, as they may contain page URLs, match values, or response payloads you entered.

## 4. Permissions

APIFaultLab requests the minimum permissions required for its single purpose:

- **`activeTab`**: Grants temporary access to the active tab when you click the toolbar icon.
- **`scripting`**: Injects the Fetch/XHR adapter and isolated message bridge into tabs you authorize, and registers `document_start` scripts when you enable startup protection for a site.
- **`storage`**: Persists your local plans, catalogs, scenarios, and session state in Chrome storage.
- **`webNavigation`**: Detects main-frame navigations and SPA route updates to group endpoints by page and restore active rules on same-origin reloads.
- **Optional host permissions (`http://*/*`, `https://*/*`)**: Requested per site only when you explicitly click **Authorize this site** so you can test local, staging, or internal development pages without granting blanket access.

## 5. Your Controls and Data Deletion

- You can pause request capture, stop active simulation rules, or delete individual plans, catalogs, ignore rules, and custom scenarios at any time in the APIFaultLab DevTools panel.
- You can revoke site access permissions at any time from `chrome://extensions`.
- Uninstalling APIFaultLab removes all extension data stored in Chrome's local and session storage. Files you manually downloaded remain under your own control.

## 6. Contact

For privacy questions or issues, please open an issue at [GitHub Issues](https://github.com/zhkai-ybwn/APIFaultLab/issues).
