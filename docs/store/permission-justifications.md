# Chrome Web Store — Permission Justifications & Privacy Practices

本文档整理了上传 Chrome Web Store 时，在 **Privacy practices（隐私做法）** 标签页可直接粘贴填写的英文说明。

---

## 1. Single Purpose Description（单一用途说明）

> **可直接粘贴：**
>
> APIFaultLab is a Chrome DevTools extension for web developers and QA engineers to discover Fetch and asynchronous XHR endpoints on the inspected web page and locally simulate API fault responses (HTTP errors, empty states, custom response headers, delays, retry hit limits, and network failures) without modifying backend services.

---

## 2. Permission Justifications（权限逐项说明）

### `activeTab`

> Grants temporary access to the currently active web page when the user clicks the APIFaultLab toolbar icon so the extension can attach its local Fetch/XHR adapter and display capture/simulation status for that tab without requiring permanent site permissions.

### `scripting`

> Injects the local, bundled Fetch/XHR adapter (`page-main.js`, `MAIN` world) and isolated telemetry bridge (`page-bridge.js`, `ISOLATED` world) into user-authorized tabs to observe endpoints and return synthetic mock responses locally. When the user explicitly enables startup protection for an authorized test site, `chrome.scripting.registerContentScripts` registers those same bundled scripts at `document_start` (non-persistent across browser sessions) so reload requests wait for rule confirmation before hitting the server.

### `storage`

> Stores user-created test plans, imported OpenAPI/Swagger or APIFaultLab endpoint catalogs, per-site ignore rules, per-site route grouping preferences, and custom response scenarios locally in `chrome.storage.local`, and stores active per-tab session rules and bounded request summaries in `chrome.storage.session` so active simulation rules survive extension Service Worker restarts and same-origin page reloads.

### `webNavigation`

> Listens to main-frame navigation events (`onCommitted`, `onHistoryStateUpdated`, `onReferenceFragmentUpdated`) and reads the main-frame document ID (`getFrame`) to group discovered requests by page URL, keep SPA navigation in sync with the DevTools workbench, restore active rules on same-origin reload, and automatically end sessions on cross-origin navigation.

### Host Permissions — `optional_host_permissions` (`http://*/*`, `https://*/*`)

> APIFaultLab does not request any mandatory host permissions at install time. Optional host permissions are requested on demand for a single origin only when the user explicitly clicks "Authorize this site" (授权此站点) in the DevTools panel. Developers and QA engineers test arbitrary local (`localhost`, `127.0.0.1`), staging, and internal enterprise URLs that cannot be predicted in advance.

---

## 3. Remote Code Declaration（远程代码声明）

- **Are you using remote code?** → **`No, I am not using Remote code`**
- **Justification (if prompted)**:
  > All JavaScript, CSS, HTML, and Web Worker bundles are compiled locally and included inside the extension package. The extension never uses `eval`, `new Function`, remote script tags, or dynamic code fetched from external URLs. Local OpenAPI/Swagger imports are parsed strictly as data in an isolated Web Worker and external `$ref` links are skipped without network requests.

---

## 4. Privacy Policy URL & Data Usage Disclosures（隐私政策与数据声明）

- **Privacy Policy URL**：
  `https://github.com/zhkai-ybwn/APIFaultLab/blob/main/docs/PRIVACY.md`
  （如需独立网页，也可启用 GitHub Pages 后填对应 HTTPS 链接）
- **Data collection checkboxes**：
  - APIFaultLab **不向任何开发者服务器或第三方收集、传输、出售数据**（All processing happens locally in the user's browser; zero external servers, zero analytics/telemetry）。
  - 勾选并确认以下三项官方合规声明（Limited Use certifications）：
    1. I do not sell or transfer user data to third parties, outside of the approved use cases.
    2. I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
    3. I do not use or transfer user data to determine creditworthiness or for lending purposes.
