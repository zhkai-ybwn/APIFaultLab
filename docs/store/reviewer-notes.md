# Chrome Web Store — Reviewer Test Notes & Pre-Submission Checklist

本文档第一部分可直接粘贴到 Chrome Web Store 后台的 **Test instructions / Notes for reviewer**，帮助审核员快速理解 DevTools 插件入口并一次性过审；第二部分是上架前的自查清单。

---

## 1. Notes for Reviewer（可直接粘贴到商店后台）

> **Overview**
> APIFaultLab is a Chrome DevTools panel extension (UI is currently in Simplified Chinese). The toolbar popup shows per-tab capture/mock status and stop controls, while rule configuration lives inside **Chrome DevTools (F12) → APIFaultLab**.
>
> **How to test on any public web page (no login or backend required)**
> 1. Open any HTTP/HTTPS page that makes Fetch/XHR requests (for example, `https://jsonplaceholder.typicode.com/` or any web app).
> 2. Open Chrome DevTools (`F12` / `Ctrl+Shift+I` / `Cmd+Option+I`) and select the **APIFaultLab** tab (expand `»` if hidden).
> 3. Click the primary button **授权此站点** ("Authorize this site") and approve Chrome's optional single-site permission prompt. Status changes to **正在采集** ("Capturing").
> 4. Trigger a request on the page (for example, click **"Run script"** on `https://jsonplaceholder.typicode.com/`, or run `fetch('/todos/1').then(r => r.json()).then(console.log)` in the DevTools Console). The request (`GET /todos/1`) appears in the APIFaultLab workbench list.
> 5. Click the request row → click **添加模拟规则** ("Add mock rule") → select a preset such as **404** or **空列表** ("Empty list") → click **启用规则** ("Enable rule") at the top of the right pane.
> 6. Trigger the same request again. The page immediately receives the locally synthesized mock response (no network request sent to the server), and the APIFaultLab row shows **本轮已命中** ("Matched").
> 7. Click **停止本页规则** ("Stop rules for this page") in the workbench (or **停止标签页规则** in the toolbar popup), then trigger the request again to confirm normal live responses resume.
>
> **Optional: Verify toolbar popup & local-only behavior**
> - Click the APIFaultLab toolbar icon to view live tab status, toggle request capture, or stop simulation rules.
> - No account, login, or external server is required. All rules, plans, and imported API specs stay strictly in local Chrome storage.

---

## 2. 上架前自查清单（Pre-Submission Checklist）

### 必需素材与配置
- [ ] **隐私政策链接**：已公开可访问（`https://github.com/zhkai-ybwn/APIFaultLab/blob/main/docs/PRIVACY.md`）
- [ ] **扩展 ZIP 包**：使用 `npm run zip` 生成 `.output/api-fault-lab-0.4.0-chrome.zip`（内含 `LICENSE` 与 `THIRD-PARTY-NOTICES.md`）
- [ ] **商店截图（1~5 张）**：尺寸严格为 **`1280×800`** 或 **`640×400`**，JPEG 或 24 位无透明通道 PNG。建议准备 4 张：
  1. 工作台主视图（左接口列表 + 右命中详情）
  2. 规则编辑器（请求头/JSON 条件 + 自定义响应头 + 最多生效次数）
  3. 批量设置与筛选（`业务` 筛选 + `忽略参数` 开关）
  4. 工具栏弹窗状态与停用控制
- [ ] **商店图标（128×128 PNG）**：核对 `public/icons/mark-128.png` 四周视觉留白（商店规范建议 96×96 图标内容居中于 128×128 画布内）
- [ ] **宣传小图（可选，建议备一张）**：`440×280` 无透明通道 PNG/JPEG

### 商店语言与灰度策略
- [ ] **主语言设置**：在添加英文 UI i18n 前，商店后台 Primary language 选择 **Chinese (Simplified)**，避免纯英文商店页引来期望英文界面的差评。
- [ ] **先 Unlisted 灰度给同事**：首次过审后可见性选 **Unlisted（仅拥有链接的用户可见）**，发链接给同事安装实测 1~2 周（免开发者模式且自动更新）；稳定后再切为 **Public** 并正式推广。
