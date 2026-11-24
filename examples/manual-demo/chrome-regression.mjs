import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Opt-in only. Both Chrome and the HTTP server are started for this run.
const chromePath = process.env.APIFAULTLAB_CHROME_PATH ??
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome')
const tempRoot = resolve(tmpdir())
const profile = await mkdtemp(join(tempRoot, 'apifaultlab-chrome-regression-'))
const server = spawn(process.execPath, [fileURLToPath(new URL('server.mjs', import.meta.url))], {
  env: { ...process.env, APIFAULTLAB_DEMO_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
})

function openChrome() {
  const process = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--enable-unsafe-extension-debugging',
    '--remote-debugging-pipe', '--auto-open-devtools-for-tabs', '--user-data-dir=' + join(profile, 'chrome'), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(process, 'exit')
  const pending = new Map()
  let buffer = ''
  let sequence = 0
  process.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const raw = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!raw) continue
      const reply = JSON.parse(raw)
      const respond = pending.get(reply.id)
      if (respond) {
        pending.delete(reply.id)
        respond(reply)
      }
    }
  })
  process.stdio[3].on('error', () => {})

  function send(method, params = {}, sessionId) {
    const id = ++sequence
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        fail(new Error(method + ' timed out'))
      }, 8000)
      pending.set(id, reply => {
        clearTimeout(timer)
        if (reply.error) fail(new Error(method + ': ' + reply.error.message))
        else done(reply.result)
      })
      process.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
    })
  }

  async function attach(targetId) {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    return sessionId
  }

  async function evaluate(page, expression) {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, page)
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
    return reply.result.value
  }

  async function close() {
    await send('Browser.close').catch(() => {})
    if (process.exitCode === null) process.kill()
    await exited.catch(() => {})
  }
  return { send, attach, evaluate, close }
}

async function waitFor(check, label) {
  const start = Date.now()
  let last
  while (Date.now() - start < 8000) {
    try {
      const value = await check()
      if (value) return value
    } catch (reason) { last = reason }
    await pause(60)
  }
  throw new Error(label + (last ? ' (' + last.message + ')' : ''))
}

const browser = openChrome()
const exitedServer = once(server, 'exit')
const textClick = text => '(() => { const item = [...document.querySelectorAll("button, summary")].find(node => node.textContent.trim() === ' +
  JSON.stringify(text) + ' && !node.disabled && node.getClientRects().length); if (!item) return false; item.click(); return true })()'
try {
  const [header] = await once(server.stdout, 'data', { signal: AbortSignal.timeout(6000) })
  const url = header.toString().match(/http:\/\/[^\s]+/)[0]
  const { origin } = new URL(url)
  const { product } = await browser.send('Browser.getVersion')
  const downloadPath = join(profile, 'downloads')
  await mkdir(downloadPath)
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath })
  const host = 'http://127.0.0.1/*'
  // The isolated headless run cannot click Chrome's native optional-host prompt.
  // Grant only the loopback fixture in a temporary copy; compiled app assets are identical.
  const extension = join(profile, 'extension-under-test')
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true })
  const manifestPath = join(extension, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, host_permissions: [host] }))
  const { id } = await browser.send('Extensions.loadUnpacked', { path: extension })

  const findTarget = (type, prefix) => waitFor(async () => {
    const listing = await browser.send('Target.getTargets', { filter: [{}] })
    return listing.targetInfos.find(target => target.type === type && target.url.startsWith(prefix))
  }, 'Missing Chrome target ' + prefix)
  const initialTarget = await findTarget('page', 'about:blank')
  const { targetId } = await browser.send('Target.createTarget', { url })
  await browser.send('Target.closeTarget', { targetId: initialTarget.targetId })
  const demo = await browser.attach(targetId)
  await browser.send('Page.navigate', { url }, demo)
  const extensionUrl = 'chrome-extension://' + id + '/workbench.html'
  const devtools = await browser.attach((await findTarget('page', 'devtools://devtools/')).targetId)
  await findTarget('iframe', 'chrome-extension://' + id + '/devtools.html')
  const chooseDevToolsPanel = `(async () => {
    const ui = await import('devtools://devtools/bundled/ui/legacy/legacy.js')
    const inspector = ui.InspectorView.InspectorView.instance()
    const tabs = inspector.tabbedPane.tabs
    const slot = tabs.find(tab => tab.title === 'APIFaultLab')
    if (!slot) return false
    await inspector.showPanel(slot.id)
    return true
  })()`
  await waitFor(() => browser.evaluate(devtools, chooseDevToolsPanel), 'Could not open APIFaultLab in native DevTools')
  const panel = await browser.attach((await findTarget('iframe', extensionUrl)).targetId)
  const canAccess = await waitFor(() => browser.evaluate(panel, 'chrome.permissions.contains({origins:[' + JSON.stringify(host) + ']})'), 'Localhost host permission was not granted')
  assert.equal(canAccess, true)
  const tabId = await waitFor(() => browser.evaluate(panel, 'chrome.devtools.inspectedWindow.tabId'), 'Could not resolve the inspected demo tab')
  const ui = expression => browser.evaluate(panel, expression)
  const click = text => waitFor(() => ui(textClick(text)), 'Missing control ' + text)
  const hasText = text => 'document.body?.innerText.includes(' + JSON.stringify(text) + ')'
  const counts = async () => (await fetch(origin + '/__counts')).json()
  const download = (prefix, label) => waitFor(async () => {
    const name = (await readdir(downloadPath)).find(item => item.startsWith(prefix) && item.endsWith('.json'))
    return name ? JSON.parse(await readFile(join(downloadPath, name), 'utf8')) : undefined
  }, label)
  const attachFile = (selector, name, json) => ui(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    const transfer = new DataTransfer()
    transfer.items.add(new File([${JSON.stringify(json)}], ${JSON.stringify(name)}, {type:'application/json'}))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', {bubbles:true}))
  })()`)
  const startupResults = () => waitFor(() => browser.evaluate(demo,
    'typeof startup === "undefined" ? null : Promise.all([startup,startupXhr])'), 'No startup replies after reload')
  async function expectPinnedApply(label, mustScroll = false) {
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 320, height: 430, deviceScaleFactor: 1, mobile: false,
    }, devtools)
    try {
      await waitFor(() => ui('window.innerWidth > 0 && window.innerWidth <= 320'), 'Narrow DevTools layout did not load')
      const position = await ui(`(() => {
        const action = [...document.querySelectorAll('.inspector-action button')]
          .find(item => item.textContent.trim() === ${JSON.stringify(label)})
        if (!action || action.disabled) return null
        const content = document.querySelector('.inspector-scroll')
        const initial = action.getBoundingClientRect().top
        content.scrollTop = content.scrollHeight
        const after = action.getBoundingClientRect()
        return { initial, top: after.top, bottom: after.bottom, viewport: innerHeight,
          left: after.left, right: after.right, width: innerWidth, scrolled: content.scrollTop > 0 }
      })()`)
      assert.ok(position, label + ' is not enabled in the detail header')
      assert.equal(position.top, position.initial, label + ' moved with the content')
      assert.ok(position.top >= 0 && position.bottom <= position.viewport &&
        position.left >= 0 && position.right <= position.width, label + ' is clipped in narrow DevTools')
      if (mustScroll) assert.ok(position.scrolled, 'The rule editor did not scroll for the pinned-action test')
    } finally {
      await browser.send('Emulation.clearDeviceMetricsOverride', {}, devtools)
    }
  }

  await waitFor(() => ui(hasText('正在采集')), 'Workbench did not attach to the demo').catch(async cause => {
    throw new Error(cause.message + ': ' + await ui('JSON.stringify({text:document.body?.innerText,tabId:chrome.devtools?.inspectedWindow?.tabId})'))
  })
  await waitFor(() => browser.evaluate(demo, 'startup.then(() => true)'), 'Demo did not complete its initial request')
  await ui(`window.__regression = (() => {
    const port = chrome.runtime.connect({name: 'api-fault-lab:panel'})
    const commands = new Map()
    let snapshot
    port.onMessage.addListener(message => {
      if (message.type === 'snapshot') snapshot = message.snapshot
      if (message.type === 'result') commands.get(message.id)?.(message)
    })
    const send = command => new Promise(resolve => {
      const id = crypto.randomUUID()
      commands.set(id, message => {commands.delete(id); resolve(message)})
      port.postMessage({id, command})
    })
    return { send, get target() {return snapshot?.target}, get snapshot() {return snapshot} }
  })()`)
  assert.equal((await ui('window.__regression.send({type:"bind",tabId:' + tabId + '})')).ok, true)
  const command = (type, extra = {}) => ui('window.__regression.send({...'+ JSON.stringify(extra) +
    ',type:' + JSON.stringify(type) + ',target:window.__regression.target})')
  const ruleFor = (operationName, status) => ({
    id: operationName, routeKey: url, endpoint: { method: 'POST', origin, path: '/api/query' },
    conditions: [{ source: 'json', path: '/operationName', value: operationName }],
    response: { kind: 'http', status, body: '[]', contentType: 'application/json', delayMs: 0 },
  })

  async function selectSharedPost() {
    if (!await ui('document.querySelector(".request-pane").getClientRects().length > 0')) await click('返回请求')
    return waitFor(() => ui(`(() => {
      const check = [...document.querySelectorAll('.interface-row input[type="checkbox"]')]
        .find(item => item.getAttribute('aria-label')?.includes('/api/query'))
      if (!check || check.disabled || !check.getClientRects().length) return false
      if (!check.checked) check.click()
      return true
    })()`), 'Could not select shared POST for a batch')
  }

  assert.equal((await browser.evaluate(demo, 'requestOperation("ListOrders")')).status, 200)
  await waitFor(() => ui(`(() => {
    const row = [...document.querySelectorAll('button[data-request-key]')].find(item => item.textContent.includes('/api/query'))
    if (!row) return false
    row.click()
    return true
  })()`), 'Could not open shared POST details without a selection')
  await click('添加模拟规则')
  await click('编辑响应')
  assert.equal(await ui(hasText('匹配此接口的所有请求')), true)
  await expectPinnedApply('启用规则', true)
  await click('启用规则')
  await waitFor(() => ui(hasText('规则已启用。')), 'Single apply did not finish')
  assert.equal((await browser.evaluate(demo, 'requestOperation("ListOrders")')).status, 404)
  assert.equal((await command('stop')).ok, true)

  await selectSharedPost()
  await click('批量设置')
  assert.equal(await ui(hasText('1 条新规则覆盖整个接口或路径模板')), true)
  await expectPinnedApply('启用 1 条规则')
  await click('启用 1 条规则')
  await waitFor(() => ui(hasText('已应用 1 条规则。')), 'Batch apply did not finish')
  assert.equal((await browser.evaluate(demo, 'requestOperation("ListOrders")')).status, 404)
  assert.equal((await command('stop')).ok, true)
  console.log('Single and broad-scope batch actions stayed visible at 320 px and applied without a confirmation checkbox')

  assert.equal((await command('apply', { rules: [
    ruleFor('StartupProbe', 429), ruleFor('StartupProbeXhr', 503), ruleFor('ListOrders', 404),
  ] })).ok, true)
  const beforeRefresh = await counts()
  await browser.send('Page.reload', { ignoreCache: true }, demo)
  const [startup, startupXhr] = await startupResults()
  assert.equal(startup.status, 429, JSON.stringify(startup))
  assert.equal(startupXhr.status, 503, JSON.stringify(startupXhr))
  const afterRefresh = await counts()
  assert.equal(afterRefresh.StartupProbe, beforeRefresh.StartupProbe, 'The server received a protected startup Fetch')
  assert.equal(afterRefresh.StartupProbeXhr, beforeRefresh.StartupProbeXhr, 'The server received a protected startup XHR')
  const real = await browser.evaluate(demo, 'requestOperation("ListCustomers")')
  assert.equal(real.status, 200)
  assert.equal((await counts()).ListCustomers, beforeRefresh.ListCustomers + 1)
  console.log(product + ' protected startup Fetch and XHR POSTs and preserved the shared endpoint passthrough')

  await selectSharedPost()
  await click('批量设置')
  assert.equal(await ui(hasText('JSON /operationName = "StartupProbe"')), true)
  assert.equal(await ui(hasText('JSON /operationName = "StartupProbeXhr"')), true)
  assert.equal(await ui(hasText('JSON /operationName = "ListOrders"')), true)
  if (!await ui(textClick('返回勾选'))) await click('返回请求')

  await click('导入')
  const catalog = (await readFile(new URL('../../skills/apifaultlab-catalog/references/共用请求目录.json', import.meta.url), 'utf8'))
    .replaceAll('http://127.0.0.1:4173', origin)
  await attachFile('form[aria-label="导入和管理接口目录"] input[type=file]', '示例目录.json', catalog)
  await click('加入当前页面')
  await waitFor(() => ui(hasText('已将 1 个接口加入当前页面。')), 'Catalog import did not finish')

  await click('方案')
  await click('新建方案')
  await waitFor(() => ui(hasText('方案名称')), 'Plan editor did not open')
  await ui(`(() => {
    const field = [...document.querySelectorAll('label')].find(node => node.textContent.includes('方案名称')).querySelector('input')
    field.value = 'Chrome 回归方案'
    field.dispatchEvent(new Event('input', {bubbles:true}))
  })()`)
  await click('返回并保留')
  await click('继续方案草稿')
  assert.equal(await ui('document.querySelector(".plan-form input").value'), 'Chrome 回归方案')
  await ui(`(() => {
    const select = document.querySelector('.plan-form select')
    const option = [...select.options].find(item => item.textContent.includes('/api/query'))
    select.value = option.value
    select.dispatchEvent(new Event('change', {bubbles:true}))
  })()`)
  await click('添加接口')
  await click('保存方案')
  await waitFor(() => ui(hasText('Chrome 回归方案')), 'Saved plan is not listed')
  assert.equal((await browser.evaluate(demo, 'requestOperation("ListCustomers")')).status, 200, 'Saving a staged plan unexpectedly applied it')
  await click('Chrome 回归方案')
  await click('分享方案')
  await click('下载摘要')
  const summary = await download('APIFaultLab-方案摘要', 'Plan summary was not downloaded')
  assert.ok(!JSON.stringify(summary).includes(origin), 'The summary exported a page address')
  assert.ok(!JSON.stringify(summary).includes('Chrome 回归方案'), 'The summary exported the plan name')
  await click('返回预览')
  await click('关闭预览')
  await click('数据备份')
  await click('导出 JSON')
  const backup = await download('APIFaultLab-备份', 'JSON backup was not downloaded')
  assert.equal(backup.schemaVersion, 1)
  assert.equal(backup.data.plans.length, 1)
  assert.ok(backup.data.imports.some(item => item.entry.operations?.length === 2))
  backup.data.plans[0] = { ...backup.data.plans[0], id: 'browser-backup-plan', name: '备份恢复方案' }
  await attachFile('.backup-tools input[type=file]', '浏览器回归备份.json', JSON.stringify(backup))
  await click('恢复 1 项配置')
  await waitFor(() => ui(hasText('备份恢复方案')), 'Restored plan is not visible')
  await click('Chrome 回归方案')
  assert.equal(await ui('Boolean(document.querySelector(".inspector-action input[type=checkbox]"))'), false)
  await expectPinnedApply('启用方案')
  const beforePlanApply = await counts()
  await click('启用方案')
  await waitFor(() => ui(hasText('方案已启用。')), 'Plan did not apply directly')
  assert.equal((await browser.evaluate(demo, 'requestOperation("ListCustomers")')).status, 404)
  assert.equal((await counts()).ListCustomers, beforePlanApply.ListCustomers, 'The enabled plan sent a matched request to the server')
  await waitFor(() => ui('document.activeElement?.textContent.trim() === "Chrome 回归方案"'), 'Focus did not return to the enabled plan')
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 800, deviceScaleFactor: 1, mobile: false,
  }, devtools)
  await waitFor(() => ui('window.innerWidth > 0 && window.innerWidth <= 320'), 'Narrow workbench viewport did not apply')
  const overflow = await ui('Math.max(document.documentElement.scrollWidth, document.querySelector(".toolbar-actions").getBoundingClientRect().right) > window.innerWidth')
  assert.equal(overflow, false, 'Workbench toolbar overflows at 320 px')
  await ui(`(() => {
    const back = document.querySelector('.back-button')
    back.focus()
    back.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))
  })()`)
  await waitFor(() => ui('document.querySelector(".request-pane").getClientRects().length > 0'), 'Escape did not return to the request list')
  await waitFor(() => ui('document.activeElement?.getClientRects().length > 0 && document.activeElement !== document.body'), 'Keyboard focus did not return to the request pane')
  await browser.send('Emulation.clearDeviceMetricsOverride', {}, devtools)
  console.log('Native DevTools verified batch scopes, import, draft, safe share, backup restore and keyboard at 320 px')

  assert.equal((await command('stop')).ok, true)
  const beforeStopRefresh = await counts()
  await browser.send('Page.reload', {}, demo)
  const unprotected = await startupResults()
  assert.deepEqual(unprotected.map(result => result.status), [200, 200])
  const afterStopRefresh = await counts()
  assert.equal(afterStopRefresh.StartupProbe, beforeStopRefresh.StartupProbe + 1)
  assert.equal(afterStopRefresh.StartupProbeXhr, beforeStopRefresh.StartupProbeXhr + 1)
  console.log('Stopped rules stayed off after reload; each startup request reached the server exactly once')

  await browser.evaluate(demo, 'sessionStorage.setItem("__apiFaultLabStartup_v1__", "orphaned-test-session")')
  await browser.send('Page.reload', {}, demo)
  assert.ok((await startupResults()).every(result => result.error), 'A startup request escaped an unconfirmed session')
  const unknownCall = await browser.evaluate(demo, `fetch('/api/query', {
    method: {toString: () => 'POST'},
    body: '{"operationName":"StartupProbe"}',
  }).then(() => false, error => error.message.includes('APIFaultLab'))`)
  assert.equal(unknownCall, true, 'An opaque Fetch call escaped startup protection')
  const afterOrphan = await counts()
  assert.equal(afterOrphan.StartupProbe, afterStopRefresh.StartupProbe)
  assert.equal(afterOrphan.StartupProbeXhr, afterStopRefresh.StartupProbeXhr)
  await waitFor(() => ui(hasText('首屏请求已阻止')), 'Workbench did not report the fail-closed startup')
  await click('停止标签页规则')
  await waitFor(() => ui('!(' + hasText('首屏请求已阻止') + ')'), 'Explicit stop did not release startup protection')
  assert.equal((await browser.evaluate(demo, 'requestOperation("StartupProbe")')).status, 200)
  console.log('An unconfirmed startup sent no POSTs and an explicit stop restored real traffic')
} finally {
  await browser.close()
  if (server.exitCode === null) server.kill()
  await exitedServer.catch(() => {})
  if (dirname(resolve(profile)) === tempRoot && basename(profile).startsWith('apifaultlab-chrome-regression-')) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4 }).catch(() => {})
  }
}
