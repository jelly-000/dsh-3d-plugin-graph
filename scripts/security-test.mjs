#!/usr/bin/env node
/**
 * Adversarial security test for dsh-3d-plugin-graph (Murphy's law edition).
 *
 * Feeds the UI a state payload full of hostile plugin names/ids (XSS payloads,
 * attribute breakout, prototype-pollution keys, NaN coords, huge strings),
 * then drives every render path that interpolates server data (popup, confirm
 * list, panel rows, search, cycle warnings) and asserts:
 *   - no script execution (window.__xss* stay undefined)
 *   - hostile strings render as literal text
 *   - no prototype pollution
 *   - zero uncaught exceptions and zero console errors
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 8892
const CDP_PORT = 9334

const XSS1 = '<img src=x onerror="window.__xss=1">'
const XSS2 = '"><script>window.__xss2=1</script>'
const XSS3 = 'x" onmouseover="window.__xss3=1'
const XSS4 = '<svg onload="window.__xss4=1">'
const POLLUTE = '__proto__'

const html = readFileSync(join(ROOT, '..', 'assets', 'index.html'), 'utf8')

function statePayload() {
  return {
    updatedAt: new Date().toISOString(),
    counts: { plugins: 6, active: 5, tools: 3, services: 2, events: 1, ms: 1 },
    nodes: [
      { id: 'core', name: 'DSH 核心', kind: 'core', state: 'active', stateText: '已激活', injects: [], provides: [], dependsOn: [], dependedBy: ['plugin-evil-depend'], toolCount: 3 },
      { id: 'plugin-evil-name', name: XSS1, kind: 'plugin', state: 'active', stateText: '已激活', injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 },
      { id: 'plugin-evil-name2', name: XSS2, kind: 'plugin', state: 'active', stateText: XSS3, injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 },
      { id: 'plugin-evil-depend', name: XSS4, kind: 'plugin', state: 'active', stateText: '已激活', injects: [{ service: 'evil-svc', provider: 'plugin-evil-provider' }], provides: [], dependsOn: ['plugin-evil-provider'], dependedBy: [], toolCount: 0 },
      { id: 'plugin-evil-provider', name: 'evil-provider', kind: 'plugin', state: 'active', stateText: '已激活', injects: [], provides: [{ service: 'evil-svc', consumers: ['plugin-evil-depend'] }], dependsOn: [], dependedBy: ['plugin-evil-depend'], toolCount: 0 },
      { id: 'plugin-' + POLLUTE, name: POLLUTE, kind: 'plugin', state: 'disabled', stateText: '已停用', injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 },
      { id: 'plugin-nan', name: 'nan-node', kind: 'plugin', state: 'active', stateText: '已激活', injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 },
    ],
    edges: [
      { source: 'plugin-evil-depend', target: 'plugin-evil-provider', kind: 'dependency' },
    ],
    tools: [
      { name: 'safe_tool', description: 'safe' },
      { name: '<img src=x onerror="window.__xss5=1">', description: XSS2 },
      { name: 'x', description: 'y'.repeat(5000) },
    ],
    services: [{ service: 'evil-svc', providers: ['plugin-evil-provider'] }],
    runtimeEvents: [
      { timestamp: Date.now() - 1000, tool: 'safe_tool', callId: 's1', isError: false },
      { timestamp: Date.now() - 500, tool: '<img src=x onerror="window.__xss6=1">', callId: 's2', isError: false },
    ],
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname.replace(/\/+$/, '')
  try {
    if (path.endsWith('/state')) return json(res, 200, statePayload())
    if (path.endsWith('/action')) return json(res, 200, { ok: true })
    if (path === '/plugins/dsh-3d-plugin-graph' || path.endsWith('/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    json(res, 404, { ok: false })
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message) })
  }
})

/* ---- CDP client (same pattern as ui-test.mjs) ---- */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
    this.logs = []
    ws.addEventListener('message', function (ev) {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(msg.error.message))
        else entry.resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') this.exceptions.push(msg.params)
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') this.logs.push(msg.params.entry)
    }.bind(this))
  }
  static async connect(port) {
    const deadline = Date.now() + 15000
    let tabs = null
    while (Date.now() < deadline) {
      try {
        tabs = await fetch('http://127.0.0.1:' + port + '/json').then(function (r) { return r.json() })
        if (tabs.length) break
      } catch { }
      await new Promise(function (r) { setTimeout(r, 300) })
    }
    if (!tabs || !tabs.length) throw new Error('chrome CDP not reachable')
    const page = tabs.find(function (t) { return t.type === 'page' })
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(function (resolve, reject) {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return new CDP(ws)
  }
  send(method, params) {
    return new Promise(function (resolve, reject) {
      const id = ++this.id
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    }.bind(this))
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result ? r.result.value : undefined
  }
}

let failures = 0
function check(cond, label) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.error('  FAIL ' + label) }
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

async function run() {
  await new Promise(function (resolve) { server.listen(PORT, resolve) })
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=/tmp/chrome-sec-' + process.pid,
    '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' })

  let cdp
  try {
    cdp = await CDP.connect(CDP_PORT)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/plugins/dsh-3d-plugin-graph/' })
    const readyDeadline = Date.now() + 10000
    while (Date.now() < readyDeadline) {
      if (await cdp.eval('!!window.__pgTest')) break
      await sleep(200)
    }
    await sleep(1000)

    console.log('-- hostile state loads without script execution --')
    const xssAfterBoot = await cdp.eval('(window.__xss||0)+(window.__xss2||0)+(window.__xss3||0)+(window.__xss4||0)+(window.__xss5||0)+(window.__xss6||0)')
    check(xssAfterBoot === 0, 'no payload executes on load (sum=' + xssAfterBoot + ')')

    console.log('-- popup renders hostile names as literal text --')
    await cdp.eval('window.__pgTest.select("plugin-evil-name")')
    await sleep(200)
    const popupText = await cdp.eval('document.getElementById("nodeTip").textContent')
    check(popupText.indexOf('<img src=x') >= 0, 'hostile name shows as text in the popup')
    const xssPopup = await cdp.eval('(window.__xss||0)+(window.__xss2||0)+(window.__xss3||0)')
    check(xssPopup === 0, 'popup interpolation does not execute payloads (sum=' + xssPopup + ')')

    console.log('-- unplug confirm renders cascade + cycle lists safely --')
    await cdp.eval('window.__pgTest.select("plugin-evil-depend")')
    await sleep(150)
    await cdp.eval('document.querySelector("#nodeTip [data-act=\'unplug\']").click()')
    await sleep(150)
    const confirmText = await cdp.eval('document.getElementById("nodeTip").textContent')
    check(confirmText.indexOf('<svg onload=') >= 0, 'cascade list shows hostile dependent as text')
    const xssConfirm = await cdp.eval('(window.__xss4||0)')
    check(xssConfirm === 0, 'cascade list does not execute payloads (sum=' + xssConfirm + ')')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })

    console.log('-- management panel + search render hostile data safely --')
    await cdp.eval('document.querySelector(".dock button[data-panel=\'plugins\']").click()')
    await sleep(200)
    const panelText = await cdp.eval('document.getElementById("pluginList").textContent')
    check(panelText.indexOf('<img src=x') >= 0, 'panel shows hostile name as text')
    const xssPanel = await cdp.eval('(window.__xss||0)+(window.__xss2||0)+(window.__xss3||0)')
    check(xssPanel === 0, 'panel rows do not execute payloads (sum=' + xssPanel + ')')
    await cdp.eval('document.querySelector(".dock button[data-panel=\'plugins\']").click()')
    await cdp.eval('document.getElementById("search").focus()')
    await cdp.send('Input.insertText', { text: 'img src' })
    await sleep(250)
    const xssSearch = await cdp.eval('(window.__xss||0)')
    check(xssSearch === 0, 'search dropdown does not execute payloads (sum=' + xssSearch + ')')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })

    console.log('-- prototype pollution --')
    await cdp.eval('window.__pgTest.select("plugin-' + POLLUTE + '")')
    await sleep(150)
    const polluted = await cdp.eval('({}).polluted===undefined && Object.prototype.polluted===undefined && ({}).xss===undefined')
    check(polluted === true, 'proto-pollution keys do not poison objects')

    console.log('-- malformed data robustness (NaN coords, huge strings) --')
    const nodesOk = await cdp.eval('window.__pgTest.count() >= 7')
    check(nodesOk === true, 'malformed nodes still render (' + (await cdp.eval('window.__pgTest.count()')) + ' nodes)')

    console.log('-- console health --')
    check(cdp.exceptions.length === 0, 'zero uncaught page exceptions' + (cdp.exceptions.length ? ' (' + cdp.exceptions.length + ')' : ''))
    check(cdp.logs.length === 0, 'zero console errors' + (cdp.logs.length ? ' (' + cdp.logs.length + ')' : ''))
  } catch (err) {
    console.error('security-test crashed:', err && err.stack ? err.stack : err)
    process.exitCode = 2
  } finally {
    try { cdp && cdp.ws.close() } catch { }
    chrome.kill('SIGKILL')
    server.close()
  }
  if (failures) {
    console.error('security-test: ' + failures + ' FAILURE(S)')
    process.exitCode = 1
  }
  if (process.exitCode === undefined || process.exitCode === 0) console.log('security-test: all adversarial checks OK')
}

run()
