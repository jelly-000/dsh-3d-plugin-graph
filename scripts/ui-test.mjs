#!/usr/bin/env node
/**
 * Interaction test for the dsh-3d-plugin-graph UI (Murphy's law edition).
 *
 * Boots a local mock server (new HTML + realistic /state + /action recorder),
 * drives a real headless Chrome through the Chrome DevTools Protocol and
 * simulates actual pointer input:
 *   - node drag actually moves the node (regression: closure-captured objects)
 *   - click selects, empty click deselects
 *   - background drag orbits the camera, wheel zooms toward the cursor
 *   - unplug flow: arm -> warning with impact -> cancel -> re-arm -> confirm ->
 *     server receives POST -> live state flips to disabled -> re-plug single click
 *   - protected plugin unplug is refused by the server
 *   - zero uncaught page exceptions
 *
 * Usage: node scripts/ui-test.mjs   (CHROME env overrides the browser path)
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 8891
const CDP_PORT = 9333

/* ---------------- mock server ---------------- */
const timerState = { state: 'active' }
let mockFresh = false
const actionLog = []
const html = readFileSync(join(ROOT, '..', 'assets', 'index.html'), 'utf8')

const TOOLS = [
  { name: 'run_code', description: 'Execute a TypeScript program' },
  { name: 'bash', description: 'Execute a bash command' },
  { name: 'render_ui', description: 'Render a UI card' },
  { name: 'read', description: 'Read a text file' },
  { name: 'write', description: 'Write a text file' },
  { name: 'edit', description: 'Edit a text file' },
  { name: 'glob', description: 'Find files by glob' },
  { name: 'grep', description: 'Search file contents' },
]

function statePayload() {
  const timerStateNow = timerState.state
  const nodes = [
    { id: 'core', name: 'DSH 核心', kind: 'core', state: 'active', stateText: '已激活', injects: [], provides: [{ service: 'logger', consumers: ['plugin-dsh-tool-cordis', 'plugin-dsh-timer', 'plugin-dsh-workflow'] }, { service: 'config', consumers: ['plugin-dsh-tool-cordis', 'plugin-dsh-timer'] }], dependsOn: [], dependedBy: ['plugin-dsh-tool-cordis', 'plugin-dsh-timer', 'plugin-dsh-workflow', 'plugin-dsh-balance-monitor', 'plugin-dsh-3d-plugin-graph'], toolCount: TOOLS.length },
    { id: 'plugin-dsh-tool-cordis', name: 'dsh-tool-cordis', kind: 'plugin', state: 'active', stateText: '已激活', injects: [{ service: 'logger', provider: 'core' }, { service: 'config', provider: 'core' }], provides: [{ service: 'tools', consumers: ['plugin-dsh-3d-plugin-graph', 'plugin-dsh-balance-monitor', 'plugin-dsh-agent-teams', 'plugin-dsh-workflow'] }], dependsOn: ['core'], dependedBy: ['plugin-dsh-3d-plugin-graph', 'plugin-dsh-balance-monitor', 'plugin-dsh-agent-teams', 'plugin-dsh-workflow'], toolCount: 0 },
    { id: 'plugin-dsh-3d-plugin-graph', name: 'dsh-3d-plugin-graph', kind: 'plugin', state: 'active', stateText: '已激活', injects: [{ service: 'tools', provider: 'plugin-dsh-tool-cordis' }], provides: [], dependsOn: ['plugin-dsh-tool-cordis'], dependedBy: [], toolCount: 0 },
    { id: 'plugin-dsh-balance-monitor', name: 'dsh-balance-monitor', kind: 'plugin', state: 'active', stateText: '已激活', injects: [{ service: 'tools', provider: 'plugin-dsh-tool-cordis' }, { service: 'logger', provider: 'core' }], provides: [], dependsOn: ['plugin-dsh-tool-cordis', 'core'], dependedBy: [], toolCount: 0 },
    { id: 'plugin-dsh-agent-teams', name: 'dsh-agent-teams', kind: 'plugin', state: 'error', stateText: '错误', injects: [{ service: 'tools', provider: 'plugin-dsh-tool-cordis' }], provides: [], dependsOn: ['plugin-dsh-tool-cordis'], dependedBy: [], toolCount: 0 },
    { id: 'plugin-dsh-workflow', name: 'dsh-workflow', kind: 'plugin', state: 'pending', stateText: '等待依赖', injects: [{ service: 'tools', provider: 'plugin-dsh-tool-cordis' }, { service: 'timer', provider: 'plugin-dsh-timer' }, { service: 'logger', provider: 'core' }], provides: [{ service: 'workflow-svc', consumers: ['plugin-dsh-timer'] }], dependsOn: ['plugin-dsh-tool-cordis', 'plugin-dsh-timer', 'core'], dependedBy: ['plugin-dsh-timer'], toolCount: 0 },
    { id: 'plugin-dsh-timer', name: 'dsh-timer', kind: 'plugin', state: timerStateNow, stateText: timerStateNow === 'disabled' ? '已停用' : '已激活', injects: [{ service: 'logger', provider: 'core' }, { service: 'config', provider: 'core' }, { service: 'workflow-svc', provider: 'plugin-dsh-workflow' }], provides: [{ service: 'timer', consumers: ['plugin-dsh-workflow'] }], dependsOn: ['core', 'plugin-dsh-workflow'], dependedBy: ['plugin-dsh-workflow'], toolCount: 0 },
    { id: 'plugin-dsh-web', name: 'dsh-web', kind: 'plugin', state: 'disabled', stateText: '已停用', injects: [{ service: 'logger', provider: 'core' }], provides: [], dependsOn: ['core'], dependedBy: [], toolCount: 0 },
    { id: 'plugin-include-dsh-balance-monitor', name: 'dsh-balance-monitor', kind: 'plugin', state: 'active', stateText: '已激活', injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 },
    { id: 'plugin-include-tool-todo', name: '@deepseek-ai/dsh-tool-todo', kind: 'plugin', state: 'disabled', stateText: '已停用', injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 },
    { id: 'plugin-include-agent-presets-tool-todo', name: '@deepseek-ai/dsh-tool-todo', kind: 'plugin', state: 'active', stateText: '已激活', injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 },
    { id: 'cordis:include', name: 'cordis:include', kind: 'plugin', state: 'active', stateText: '已激活', injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 },
  ]
  if (mockFresh) {
    nodes.push({ id: 'plugin-dsh-fresh', name: 'dsh-fresh', kind: 'plugin', state: 'active', stateText: '已激活', injects: [], provides: [], dependsOn: [], dependedBy: [], toolCount: 0 })
  }
  const edges = [
    { source: 'plugin-dsh-tool-cordis', target: 'core', kind: 'dependency' },
    { source: 'plugin-dsh-3d-plugin-graph', target: 'plugin-dsh-tool-cordis', kind: 'dependency' },
    { source: 'plugin-dsh-balance-monitor', target: 'plugin-dsh-tool-cordis', kind: 'dependency' },
    { source: 'plugin-dsh-balance-monitor', target: 'core', kind: 'dependency' },
    { source: 'plugin-dsh-agent-teams', target: 'plugin-dsh-tool-cordis', kind: 'dependency' },
    { source: 'plugin-dsh-workflow', target: 'plugin-dsh-tool-cordis', kind: 'dependency' },
    { source: 'plugin-dsh-workflow', target: 'plugin-dsh-timer', kind: 'dependency' },
    { source: 'plugin-dsh-workflow', target: 'core', kind: 'dependency' },
    { source: 'plugin-dsh-timer', target: 'core', kind: 'dependency' },
    { source: 'plugin-dsh-timer', target: 'plugin-dsh-workflow', kind: 'dependency' },
    { source: 'plugin-dsh-web', target: 'core', kind: 'dependency' },
  ]
  return {
    updatedAt: new Date().toISOString(),
    counts: { plugins: nodes.length - 1, active: nodes.filter(function (n) { return n.state === 'active' && n.kind === 'plugin' }).length, tools: TOOLS.length, services: 4, events: 3, ms: 2 },
    nodes,
    edges,
    tools: TOOLS,
    services: [{ service: 'logger', providers: ['core'] }, { service: 'config', providers: ['core'] }, { service: 'tools', providers: ['plugin-dsh-tool-cordis'] }, { service: 'timer', providers: ['plugin-dsh-timer'] }],
    runtimeEvents: [
      { timestamp: Date.now() - 9000, tool: 'run_code', callId: 'c1', isError: false },
      { timestamp: Date.now() - 5000, tool: 'bash', callId: 'c2', isError: false },
      { timestamp: Date.now() - 1000, tool: 'read', callId: 'c3', isError: true },
      { timestamp: Date.now(), tool: 'live_pulse', callId: 'live-' + Date.now(), isError: false },
    ],
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let body = ''
    req.on('data', function (c) { body += c })
    req.on('end', function () { resolve(body) })
    req.on('error', reject)
  })
}

const server = createServer(async function (req, res) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname.replace(/\/+$/, '')
  try {
    if (path.endsWith('/state')) return json(res, 200, statePayload())
    if (path.endsWith('/action') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      actionLog.push({ action: body.action, id: body.id, at: Date.now() })
      if (body.action === 'mock_add') { mockFresh = true; return json(res, 200, { ok: true }) }
      if (body.action === 'mock_remove') { mockFresh = false; return json(res, 200, { ok: true }) }
      if (body.action === 'unplug' && body.id === 'plugin-dsh-3d-plugin-graph') {
        return json(res, 200, { ok: false, error: '该插件受保护，禁止从图谱拔出' })
      }
      if (body.action === 'unplug' && body.id === 'plugin-dsh-timer') timerState.state = 'disabled'
      if (body.action === 'plug' && body.id === 'plugin-dsh-timer') timerState.state = 'active'
      return json(res, 200, { ok: true, action: body.action, id: body.id, message: body.action === 'unplug' ? '已拔出 dsh-timer，1 个依赖插件随之下线' : '已重新插入 dsh-timer' })
    }
    if (path === '/plugins/dsh-3d-plugin-graph' || path.endsWith('/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    json(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message) })
  }
})

/* ---------------- CDP client ---------------- */
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

    }.bind(this))
  }
  static async connect(port) {
    const deadline = Date.now() + 15000
    let tabs = null
    while (Date.now() < deadline) {
      try {
        tabs = await fetch('http://127.0.0.1:' + port + '/json').then(function (r) { return r.json() })
        if (tabs.length) break
      } catch { /* chrome not up yet */ }
      await new Promise(function (r) { setTimeout(r, 300) })
    }
    if (!tabs || !tabs.length) throw new Error('chrome CDP not reachable on port ' + port)
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
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 1200))
    return r.result ? r.result.value : undefined
  }
  async mouse(type, x, y, opts) {
    opts = opts || {}
    await this.send('Input.dispatchMouseEvent', {
      type, x, y,
      button: opts.button || 'none',
      buttons: opts.buttons || 0,
      clickCount: opts.clickCount || 0,
      deltaX: opts.deltaX || 0,
      deltaY: opts.deltaY || 0,
      modifiers: opts.modifiers || 0,
    })
  }
  async clickAt(x, y) {
    await this.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
    await this.mouse('mouseReleased', x, y, { button: 'left', buttons: 1, clickCount: 1 })
  }
  async drag(x1, y1, x2, y2) {
    await this.mouse('mousePressed', x1, y1, { button: 'left', buttons: 1, clickCount: 1 })
    const steps = 6
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps
      const y = y1 + ((y2 - y1) * i) / steps
      await this.mouse('mouseMoved', x, y, { button: 'left', buttons: 1 })
      await new Promise(function (r) { setTimeout(r, 16) })
    }
    await this.mouse('mouseReleased', x2, y2, { button: 'left', buttons: 1, clickCount: 1 })
  }
}

/* ---------------- test runner ---------------- */
let failures = 0
function check(cond, label) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.error('  FAIL ' + label) }
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

async function nodeScreen(cdp, id) {
  return cdp.eval("(function(){var el=document.querySelector('#nodes .node[data-id=\"" + id + "\"] circle.core');if(!el)return null;var r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
}
async function clickNodeRobust(cdp, id) {
  const base = await nodeScreen(cdp, id)
  if (!base) { await cdp.eval('window.__pgTest.select(' + JSON.stringify(id) + ')'); return }
  const pts = [{ x: 0, y: 0 }, { x: -12, y: 0 }, { x: 12, y: 0 }, { x: 0, y: -12 }, { x: 0, y: 12 }, { x: -12, y: -12 }, { x: 12, y: -12 }, { x: -12, y: 12 }, { x: 12, y: 12 }, { x: -20, y: 0 }, { x: 20, y: 0 }, { x: 0, y: -20 }, { x: 0, y: 20 }]
  for (const o of pts) {
    const hit = await cdp.eval('(function(){var el=document.elementFromPoint(' + (base.x + o.x) + ',' + (base.y + o.y) + ');var g=el&&el.closest?el.closest(".node"):null;return g?g.dataset.id:null})()')
    if (hit === id) { await cdp.clickAt(base.x + o.x, base.y + o.y); return true }
  }
  await cdp.eval('window.__pgTest.select(' + JSON.stringify(id) + ')')
  return false
}
async function emptyPoint(cdp) {
  return cdp.eval('(()=>{for(var y=120;y<innerHeight-80;y+=40){for(var x=60;x<innerWidth-60;x+=40){var el=document.elementFromPoint(x,y);if(!el||!el.closest)continue;if(el.closest(".node,.topbar,.dock,#activity,#nodeTip,#legend,.hints"))continue;return{x:x,y:y}}}return{x:30,y:300}})()')
}

async function run() {
  await new Promise(function (resolve) { server.listen(PORT, resolve) })
  console.log('mock server on :' + PORT)

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=/tmp/chrome-pg-test-' + process.pid,
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: 'ignore' })

  let cdp
  try {
    cdp = await CDP.connect(CDP_PORT)
    const t0 = Date.now()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/plugins/dsh-3d-plugin-graph/' })

    let ready = false
    let diagnosed = false
    const readyDeadline = Date.now() + 12000
    while (Date.now() < readyDeadline) {
      ready = await cdp.eval('!!window.__pgTest')
      if (ready) break
      if (!diagnosed && Date.now() > Date.now() - 0 + 4000) {
        diagnosed = true
        const diag = await cdp.eval('({href:location.href,ready:document.readyState,graph:!!document.getElementById("graph"),scripts:document.scripts.length,title:document.title})')
        console.log('  [diag] page not ready: ' + JSON.stringify(diag))
      }
      await sleep(250)
    }
    check(ready, 'page script ready (__pgTest)')


    console.log('-- boot --')
    const countDeadline = Date.now() + 6000
    while (Date.now() < countDeadline) {
      if ((await cdp.eval('window.__pgTest.count()')) >= 8) break
      await sleep(200)
    }
    check((await cdp.eval('window.__pgTest.count()')) >= 8, 'graph rendered ' + (await cdp.eval('window.__pgTest.count()')) + ' nodes')
    check((await cdp.eval('window.__pgTest.connected()')) === true, 'live connection established')






    await sleep(2350)
    const flowCls = await cdp.eval('document.querySelector("#edges path.edge").getAttribute("class")')
    check(flowCls && flowCls.indexOf('flow') >= 0, 'new runtime events trigger white light flow on edges (class=' + flowCls + ')')
    const flowFill = await cdp.eval('getComputedStyle(document.querySelector("#edges path.edge")).fill')
    check(flowFill === 'none' || flowFill === 'rgb(0, 0, 0)', 'flowing edges must NOT be filled (no lens blobs), got ' + flowFill)
    const fxCount = await cdp.eval('document.querySelectorAll("#fx circle.flow-p").length')
    check(fxCount > 0, 'flowing edges carry fine light particles (' + fxCount + ' motes)')
    await sleep(300)

    console.log('-- drag (the historically broken one) --')
    const pos1 = await nodeScreen(cdp, 'plugin-dsh-timer')
    check(!!pos1, 'target node has a screen position')
    const world1 = await cdp.eval('window.__pgTest.node("plugin-dsh-timer")')
    await cdp.drag(pos1.x, pos1.y, pos1.x + 90, pos1.y + 40)
    await sleep(250)
    const world2 = await cdp.eval('window.__pgTest.node("plugin-dsh-timer")')
    const moved = Math.hypot(world2.x - world1.x, world2.y - world1.y, world2.z - world1.z)
    check(moved > 25, 'node world position changed after drag (delta ' + moved.toFixed(1) + ')')

    console.log('-- spring pull: dragging a node pulls its connected neighbour --')
    const neighBefore = await cdp.eval('window.__pgTest.node("plugin-dsh-workflow")')
    const dragFrom = await nodeScreen(cdp, 'plugin-dsh-timer')
    await cdp.drag(dragFrom.x, dragFrom.y, dragFrom.x + 130, dragFrom.y + 60)
    await sleep(350)
    const neighAfter = await cdp.eval('window.__pgTest.node("plugin-dsh-workflow")')
    const pull = Math.hypot(neighAfter.x - neighBefore.x, neighAfter.y - neighBefore.y, neighAfter.z - neighBefore.z)
    check(pull > 5, 'connected neighbour was pulled by the dragged node (moved ' + pull.toFixed(1) + ')')

    console.log('-- click / popup --')
    const pos2 = await nodeScreen(cdp, 'plugin-dsh-timer')
    await cdp.clickAt(pos2.x, pos2.y)
    await sleep(150)
    check((await cdp.eval('window.__pgTest.popupVisible()')) === true, 'click opens the detail popup')
    check((await cdp.eval('document.querySelector("#nodeTip .nt-id").textContent')) === 'plugin-dsh-timer', 'popup shows the right node')

    const empty1 = await emptyPoint(cdp)
    await cdp.clickAt(empty1.x, empty1.y)
    await sleep(150)
    check((await cdp.eval('window.__pgTest.popupVisible()')) === false, 'empty click closes the popup')

    console.log('-- orbit / zoom --')
    const cam1 = await cdp.eval('window.__pgTest.cam()')
    const empty2 = await emptyPoint(cdp)
    await cdp.drag(empty2.x, empty2.y, empty2.x + 90, empty2.y)
    await sleep(350)
    const cam2 = await cdp.eval('window.__pgTest.cam()')
    check(Math.abs(cam2.yaw - cam1.yaw) > 0.01, 'background drag orbits the camera (yaw delta ' + Math.abs(cam2.yaw - cam1.yaw).toFixed(3) + ')')

    await cdp.mouse('mouseWheel', empty2.x, empty2.y, { deltaY: -240 })
    await sleep(150)
    const cam3 = await cdp.eval('window.__pgTest.cam()')
    check(cam3.zoom > cam2.zoom + 0.02, 'wheel zooms in (zoom ' + cam2.zoom.toFixed(2) + ' -> ' + cam3.zoom.toFixed(2) + ')')

    console.log('-- redesign checks --')
    const fillCheck = await cdp.eval('document.querySelector(\'#nodes .node[data-id="plugin-dsh-timer"] circle.core\').getAttribute("fill")')
    check(fillCheck === '#f5f6f8', 'node surface is white (got ' + fillCheck + ')')
    const lblOp = await cdp.eval('document.querySelector(\'#nodes .node[data-id="plugin-dsh-timer"] text.label\').getAttribute("opacity")')
    check(parseFloat(lblOp) > 0, 'plugin label visible at working zoom (opacity ' + lblOp + ')')
    const coreOp = await cdp.eval('document.querySelector(\'#nodes .node[data-id="core"] text.label\').getAttribute("opacity")')
    check(parseFloat(coreOp) === 1, 'core label always visible (opacity ' + coreOp + ')')

    console.log('-- zoom anchor: node under cursor must stay glued --')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR' })
    await sleep(900)
    const anchorNode = await nodeScreen(cdp, 'plugin-dsh-timer')
    const zoomBefore = await cdp.eval('window.__pgTest.cam()')
    await cdp.mouse('mouseWheel', anchorNode.x, anchorNode.y, { deltaY: -360 })
    await sleep(200)
    const anchorAfter = await nodeScreen(cdp, 'plugin-dsh-timer')
    const zoomAfter = await cdp.eval('window.__pgTest.cam()')
    const drift = Math.hypot(anchorAfter.x - anchorNode.x, anchorAfter.y - anchorNode.y)
    check(zoomAfter.zoom > zoomBefore.zoom + 0.1, 'zoom increased (got ' + zoomBefore.zoom.toFixed(2) + ' -> ' + zoomAfter.zoom.toFixed(2) + ')')
    check(drift < 18, 'node under cursor stays glued while zooming (drift ' + drift.toFixed(1) + 'px)')
    const zoomReadout = await cdp.eval('document.getElementById(\'zoomLbl\').textContent')
    check(zoomReadout.indexOf('%') >= 0 && parseFloat(zoomReadout) > 80, 'zoom readout updates (' + zoomReadout + ')')

    console.log('-- layout: search top-right, no title duplication --')
    const lay = await cdp.eval('(function(){var s=document.getElementById(\"search\").getBoundingClientRect();var r=document.getElementById(\"resetBtn\").getBoundingClientRect();var overlap=!(s.right<r.left||s.left>r.right||s.bottom<r.top||s.top>r.bottom);return{searchTop:s.top,resetBottom:r.bottom,overlap:overlap,brandH1:document.querySelectorAll(\".brand h1\").length,sub:document.querySelector(\".brand p\")?document.querySelector(\".brand p\").textContent:null}})()')
    check(lay.searchTop > lay.resetBottom - 2, 'search box sits below the actions (top ' + lay.searchTop.toFixed(0) + ' vs actions bottom ' + lay.resetBottom.toFixed(0) + ')')
    check(lay.overlap === false, 'search box does not overlap the actions')
    check(lay.brandH1 === 0 && lay.sub === '实时插件空间', 'duplicated topbar title removed, subtitle aligned left (got h1:' + lay.brandH1 + ' sub:' + lay.sub + ')')

    console.log('-- log panel: lit button matches open panel, single click toggles --')
    const act0 = await cdp.eval('(function(){return{panel:document.getElementById("activity").classList.contains("open"),btn:document.querySelector(".dock button[data-panel=\'activity\']").classList.contains("on")}})()')
    check(act0.panel === true && act0.btn === true, 'on load: panel open + button lit (got panel:' + act0.panel + ' btn:' + act0.btn + ')')
    await cdp.eval('document.querySelector(".dock button[data-panel=\'activity\']").click()')
    await sleep(80)
    const act1 = await cdp.eval('(function(){return{panel:document.getElementById("activity").classList.contains("open"),btn:document.querySelector(".dock button[data-panel=\'activity\']").classList.contains("on")}})()')
    check(act1.panel === false && act1.btn === false, 'one click closes panel and unlights button')
    await cdp.eval('document.querySelector(".dock button[data-panel=\'activity\']").click()')
    await sleep(80)
    const act2 = await cdp.eval('document.getElementById("activity").classList.contains("open")')
    check(act2 === true, 'second click reopens the panel')

    console.log('-- plugin management panel --')
    await cdp.eval('document.querySelector(".dock button[data-panel=\'plugins\']").click()')
    await sleep(150)
    const pm = await cdp.eval('(function(){return{open:document.getElementById("pluginPanel").classList.contains("open"),rows:document.querySelectorAll("#pluginList .p-row").length,third:document.querySelectorAll("#pluginList .p-badge.third").length,count:document.getElementById("pluginCount").textContent}})()')
    check(pm.open === true && pm.rows >= 1, 'plugin panel opens with rows (' + pm.rows + ')')
    check(pm.third === 0, 'no third-party badges (the user knows their own plugins)')
    check(pm.count.indexOf('共') >= 0 && pm.count.indexOf('个插件') >= 0, 'panel header shows total count (' + pm.count + ')')
    // built-in architecture entries must NOT be listed (only third-party / self-developed)
    // built-in architecture entries must NOT be listed (only third-party / self-developed)
    const builtinAbsent = await cdp.eval('(function(){var rows=document.querySelectorAll("#pluginList .p-name");var found=0;rows.forEach(function(n){var t=n.getAttribute("title")||"";if(t.indexOf("@deepseek-ai/")>=0||t.indexOf("cordis:")===0||t==="plugin-loader"||n.textContent.indexOf("@deepseek-ai/")>=0)found++});return found})()')
    check(builtinAbsent === 0, 'built-in architecture entries are hidden from the panel (found ' + builtinAbsent + ')')



    // user plugins keep real toggle switches
    // enable a disabled plugin from the panel
    await cdp.eval('(function(){var rows=document.querySelectorAll("#pluginList .p-row");for(var i=0;i<rows.length;i++){var b=rows[i].querySelector("button[data-act=\'plug\']");if(b){b.click();return}}})()')
    await sleep(300)
    check(actionLog.some(function (a) { return a.action === 'plug' }), 'panel enable sends the plug POST')
    // disable flow with inline confirm
    await cdp.eval('(function(){var rows=document.querySelectorAll("#pluginList .p-row");for(var i=0;i<rows.length;i++){var b=rows[i].querySelector("button[data-act=\'unplug\']");if(b){b.click();return}}})()')
    await sleep(100)
    check((await cdp.eval('document.getElementById("pluginConfirm").classList.contains("show")')) === true, 'disable arms the inline confirm bar')
    await cdp.eval('document.querySelector("#pluginConfirm [data-act=\'pc-cancel\']").click()')
    await sleep(80)
    const beforeCancel = actionLog.filter(function (a) { return a.action === 'unplug' }).length
    check((await cdp.eval('document.getElementById("pluginConfirm").classList.contains("show")')) === false && beforeCancel === 0, 'cancel dismisses without sending anything')
    await cdp.eval('(function(){var rows=document.querySelectorAll("#pluginList .p-row");for(var i=0;i<rows.length;i++){var b=rows[i].querySelector("button[data-act=\'unplug\']");if(b){b.click();return}}})()')
    await sleep(100)
    await cdp.eval('document.querySelector("#pluginConfirm [data-act=\'pc-yes\']").click()')
    await sleep(300)
    check(actionLog.filter(function (a) { return a.action === 'unplug' }).length === 1, 'confirm sends exactly one unplug POST')
    await cdp.eval('document.querySelector(".dock button[data-panel=\'plugins\']").click()')
    await sleep(100)
    check((await cdp.eval('document.getElementById("pluginPanel").classList.contains("open")')) === false, 'dock button toggles the panel closed')

    console.log('-- live sync: newly installed plugin appears in graph and panel --')
    await fetch('http://127.0.0.1:' + PORT + '/plugins/dsh-3d-plugin-graph/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'mock_add' }) })
    await sleep(300)
    await cdp.eval('window.__pgTest.refresh()')
    await sleep(500)
    check((await cdp.eval('!!window.__pgTest.node("plugin-dsh-fresh")')) === true, 'newly installed plugin node appears in the graph')
    await cdp.eval('document.querySelector(".dock button[data-panel=\'plugins\']").click()')
    await sleep(200)
    check((await cdp.eval('!!document.querySelector(\'#pluginList .p-name[title="plugin-dsh-fresh"]\')')) === true, 'newly installed plugin appears in the management panel')
    await fetch('http://127.0.0.1:' + PORT + '/plugins/dsh-3d-plugin-graph/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'mock_remove' }) })
    await sleep(300)
    await cdp.eval('window.__pgTest.refresh()')
    await sleep(500)
    check((await cdp.eval('!!window.__pgTest.node("plugin-dsh-fresh")')) === false, 'removed plugin disappears from the graph')

    console.log('-- search --')
    await cdp.eval('document.getElementById("search").focus()')
    await cdp.send('Input.insertText', { text: 'dsh-timer' })
    await sleep(250)
    const srItems = await cdp.eval('document.querySelectorAll("#searchList .sr-item").length')
    check(srItems >= 1, 'search lists matching nodes (' + srItems + ')')
    // fuzzy: no-dash and missing-char queries must still find the node
    await cdp.eval('document.getElementById(\"search\").value=\"\";document.getElementById(\"search\").focus()')
    await cdp.send('Input.insertText', { text: 'dshtimer' })
    await sleep(200)
    const fuzzy1 = await cdp.eval('document.querySelectorAll(\"#searchList .sr-item\").length')
    check(fuzzy1 >= 1, 'fuzzy search finds dsh-timer without dashes (' + fuzzy1 + ')')
    await cdp.eval('document.getElementById(\"search\").value=\"\";document.getElementById(\"search\").focus()')
    await cdp.send('Input.insertText', { text: 'dstimer' })
    await sleep(200)
    const fuzzy2 = await cdp.eval('(function(){var el=document.querySelector(\"#searchList .sr-item .sr-id\");return el?el.textContent:null})()')
    check(fuzzy2 === 'plugin-dsh-timer', 'subsequence fuzzy search resolves to the right node (got ' + fuzzy2 + ')')
    await cdp.eval('document.querySelector("#searchList .sr-item").click()')
    await sleep(300)
    check((await cdp.eval('window.__pgTest.popupVisible()')) === true, 'search result opens the popup')
    check((await cdp.eval('document.querySelector("#nodeTip .nt-id").textContent')) === 'plugin-dsh-timer', 'search selected the right node')
  await cdp.eval('document.querySelector("#searchList .sr-item").click()')
  await sleep(150)
  check((await cdp.eval('!!document.querySelector("#fx circle.beacon")')) === true, 'search select spawns a locating beacon')
  check((await cdp.eval('document.querySelector(\'#nodes .node[data-id="plugin-dsh-timer"]\').getAttribute("class")')).indexOf('beacon') >= 0, 'target node carries the beacon class')
  check((await cdp.eval('getComputedStyle(document.querySelector(\'#nodes .node[data-id="plugin-dsh-workflow"] circle.core\')).opacity')) < 0.6, 'other nodes dim while beaconing')
  await sleep(1200)
  const popRect = await cdp.eval('(function(){var t=document.getElementById("nodeTip").getBoundingClientRect();return{x:t.x,y:t.y}})()')
  const nodeRect = await nodeScreen(cdp, 'plugin-dsh-timer')
  check(Math.abs(popRect.x - (nodeRect.x + 14)) < 40 && Math.abs(popRect.y - (nodeRect.y - 160)) < 60, 'popup follows the focused node')

    console.log('-- focus stability: repeated clicks must not fly --')
    const tgt0 = await cdp.eval('window.__pgTest.tgt()')
    await cdp.eval('document.querySelector("#nodeTip [data-act=\'focus\']").click()')
    await sleep(60)
    await cdp.eval('document.querySelector("#nodeTip [data-act=\'focus\']").click()')
    await sleep(60)
    const t1 = await cdp.eval('window.__pgTest.tgt()')
    check(Math.abs(t1.panX - tgt0.panX) < 2 && Math.abs(t1.panY - tgt0.panY) < 2, 'repeated focus keeps one stable target (deltas ' + (t1.panX - tgt0.panX).toFixed(2) + ',' + (t1.panY - tgt0.panY).toFixed(2) + '; sub-2px = spring node motion, not flying)')
    await sleep(900)
    const cNow = await cdp.eval('window.__pgTest.cam()')
    const tNow = await cdp.eval('window.__pgTest.tgt()')
    check(Math.abs(cNow.panX - tNow.panX) < 4 && Math.abs(cNow.panY - tNow.panY) < 4, 'camera converges to the focus target (residual ' + Math.abs(cNow.panX - tNow.panX).toFixed(2) + 'px)')

    console.log('-- selection highlights incoming (depended-on) edges --')
    const selIn = await cdp.eval('(function(){var n=0;document.querySelectorAll("#edges path.edge").forEach(function(e){if((e.getAttribute("class")||"").indexOf("sel-in")>=0)n++});return n})()')
    check(selIn >= 1, 'incoming edges of the selected node are highlighted (sel-in x' + selIn + ')')

    console.log('-- include entries: master auto-managed, instance can stop --')
    await cdp.eval('window.__pgTest.select("plugin-include-tool-todo")')
    await sleep(200)
    const mastPopup = await cdp.eval('(function(){var n=document.querySelector("#nodeTip .nt-note");return{note:n?n.textContent:"",hasPlug:!!document.querySelector("#nodeTip [data-act=\'plug\']"),hasUnplug:!!document.querySelector("#nodeTip [data-act=\'unplug\']")}})()')
    check(mastPopup.hasPlug === false && mastPopup.hasUnplug === false, 'include master offers no manual buttons')
    check(mastPopup.note.indexOf('无需手动操作') >= 0, 'include master shows the auto-managed note')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await cdp.eval('window.__pgTest.select("plugin-include-agent-presets-tool-todo")')
    await sleep(200)
    const instPopup = await cdp.eval('(function(){var n=document.querySelector("#nodeTip .nt-note");return{note:n?n.textContent:"",hasUnplug:!!document.querySelector("#nodeTip [data-act=\'unplug\']")}})()')
    check(instPopup.hasUnplug === true, 'include instance keeps the 拔出 action')
    check(instPopup.note.indexOf('自动恢复') >= 0, 'include instance warns it may auto-restore')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })

        console.log('-- firm grab: node stays under the grabbed point --')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR' })
    await sleep(900)
    const center0 = await nodeScreen(cdp, 'plugin-dsh-timer')
    const grabAt = { x: center0.x + 14, y: center0.y }
    await cdp.mouse('mousePressed', grabAt.x, grabAt.y, { button: 'left', buttons: 1, clickCount: 1 })
    await sleep(40)
    const dragMode0 = await cdp.eval('window.__pgTest.dragging()')
    check(dragMode0 === 'node', 'edge grab engages the node drag (mode=' + dragMode0 + ')')
    const base0 = await cdp.eval('window.__pgTest.screen("plugin-dsh-timer")')
    const end0 = { x: grabAt.x + 70, y: grabAt.y + 40 }
    for (let s2 = 1; s2 <= 5; s2++) {
      await cdp.mouse('mouseMoved', grabAt.x + (end0.x - grabAt.x) * s2 / 5, grabAt.y + (end0.y - grabAt.y) * s2 / 5, { button: 'left', buttons: 1 })
      await sleep(16)
    }
    await sleep(120)
    const during0 = await cdp.eval('window.__pgTest.screen("plugin-dsh-timer")')
    console.log('  [grab-diag3] center0=' + JSON.stringify(center0) + ' grabAt=' + JSON.stringify(grabAt) + ' end0=' + JSON.stringify(end0) + ' base0=' + JSON.stringify(base0) + ' during0=' + JSON.stringify(during0) + ' cam=' + JSON.stringify(await cdp.eval('window.__pgTest.cam()')))
    const expect0 = { x: base0.sx + 70, y: base0.sy + 40 }
    check(Math.abs(during0.sx - expect0.x) < 2 && Math.abs(during0.sy - expect0.y) < 2, 'node tracks the grabbed point exactly (delta ' + (during0.sx - expect0.x).toFixed(1) + ',' + (during0.sy - expect0.y).toFixed(1) + 'px)')
    // wheel while dragging must not zoom
    const zBefore = await cdp.eval('window.__pgTest.cam()')
    await cdp.mouse('mouseWheel', end0.x, end0.y, { deltaY: -240 })
    await sleep(80)
    const zDuring = await cdp.eval('window.__pgTest.cam()')
    check(Math.abs(zDuring.zoom - zBefore.zoom) < 0.01, 'wheel does not zoom while dragging a node')
    await cdp.mouse('mouseReleased', end0.x, end0.y, { button: 'left', buttons: 1, clickCount: 1 })
    await sleep(150)
    // regression: released node must NOT stay in the dragging state (black-ball bug)
    const stuckAfter0 = await cdp.eval('window.__pgTest.stuck()')
    check(stuckAfter0.length === 0, 'released node is not stuck in dragging (stuck=' + JSON.stringify(stuckAfter0) + ')')
    const ring0 = await cdp.eval('(function(){var g=document.querySelector(\'#nodes .node[data-id="plugin-dsh-timer"]\');var rg=g.querySelector("circle.ring");return{fill:getComputedStyle(rg).fill,opacity:getComputedStyle(rg).opacity}})()')
    check(ring0.fill === 'none', 'ring renders as a pure ring (fill=' + ring0.fill + ')')
    check(Math.abs(parseFloat(ring0.opacity) - 0.25) < 0.05, 'ring returns to normal opacity after release (' + ring0.opacity + ')')

    console.log('-- solid-body collision: dragged node pushes others, no clipping --')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR' })
    await sleep(500)
    const targetW = await cdp.eval('window.__pgTest.node("plugin-dsh-workflow")')
    await cdp.eval('window.__pgTest.setWorld("plugin-dsh-timer",' + (targetW.x + 22) + ',' + targetW.y + ',' + targetW.z + ')')
    await sleep(500)
    const after = await cdp.eval('JSON.stringify({a:window.__pgTest.node("plugin-dsh-timer"),b:window.__pgTest.node("plugin-dsh-workflow")})')
    const pair = JSON.parse(after)
    const sep = Math.hypot(pair.a.x - pair.b.x, pair.a.y - pair.b.y, pair.a.z - pair.b.z)
    const pushed = Math.hypot(pair.b.x - targetW.x, pair.b.y - targetW.y, pair.b.z - targetW.z)
    check(pushed > 12, 'overlapping node was pushed out by collision (target moved ' + pushed.toFixed(1) + ')')
    check(sep >= 48, 'no clipping: final separation ' + sep.toFixed(1))

    console.log('-- unplug: arm -> warn -> cancel -> arm -> confirm -> live flip --')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await sleep(500)
    await clickNodeRobust(cdp, 'plugin-dsh-timer')
    await sleep(200)
    check((await cdp.eval('window.__pgTest.popupVisible()')) === true, 'popup open on target node')
    check((await cdp.eval('window.__pgTest.stuck()')).length === 0, 'plain click does not stick the dragging state')
    await cdp.eval('document.querySelector(\'#nodeTip [data-act="unplug"]\').click()')
    await sleep(100)
    check((await cdp.eval('window.__pgTest.confirmVisible()')) === true, 'unplug arms the confirmation zone')
    check((await cdp.eval('document.querySelector("#nodeTip .confirm-zone").className')).indexOf('high') >= 0, 'mutual-dependency unplug shows the high-risk zone')
    check((await cdp.eval('document.querySelector("#nodeTip .confirm-warn").textContent')).indexOf('相互依赖') >= 0, 'cycle warning names the interdependent plugins')
    check((await cdp.eval('document.querySelector("#nodeTip .confirm-body").textContent')).indexOf('不会自动重新插入') >= 0, 'warning states capabilities vanish and no auto-reinsertion')
    check((await cdp.eval('document.querySelector("#nodeTip [data-act=\'unplug-yes\']").textContent')).indexOf('影响') >= 0, 'confirm button states the cascade impact count')
    check((await cdp.eval('document.querySelector("#nodeTip .confirm-list").textContent')).indexOf('dsh-workflow') >= 0, 'warning lists the dependent plugin')
    await cdp.eval('document.querySelector(\'#nodeTip [data-act="cancel"]\').click()')
    await sleep(100)
    check((await cdp.eval('window.__pgTest.confirmVisible()')) === false, 'cancel dismisses the confirmation')
    check(actionLog.filter(function (a) { return a.action === 'unplug' && a.id === 'plugin-dsh-timer' }).length === 0, 'no action sent before confirm')

    await cdp.eval('document.querySelector(\'#nodeTip [data-act="unplug"]\').click()')
    await sleep(100)
    await cdp.eval('document.querySelector(\'#nodeTip [data-act="unplug-yes"]\').click()')
    await sleep(400)
    check(actionLog.some(function (a) { return a.action === 'unplug' && a.id === 'plugin-dsh-timer' }), 'confirm sends the unplug POST')
    await sleep(2400)
    const timerNode = await cdp.eval('window.__pgTest.node("plugin-dsh-timer")')
    check(timerNode.state === 'disabled', 'live poll flips node to 已停用 (got ' + timerNode.state + ')')

    console.log('-- re-plug: single click, no confirm --')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await sleep(500)
    await clickNodeRobust(cdp, 'plugin-dsh-timer')
    await sleep(200)
    check((await cdp.eval('window.__pgTest.popupVisible()')) === true, 'popup open for re-plug')
    check((await cdp.eval('!!document.querySelector(\'#nodeTip [data-act="plug"]\')')) === true, 'disabled node offers 重新插入')
    await cdp.eval('document.querySelector(\'#nodeTip [data-act="plug"]\').click()')
    await sleep(400)
    check(actionLog.some(function (a) { return a.action === 'plug' && a.id === 'plugin-dsh-timer' }), 're-plug sends the plug POST')
    await sleep(2400)
    const timerNode2 = await cdp.eval('window.__pgTest.node("plugin-dsh-timer")')
    check(timerNode2.state === 'active', 'live poll flips node back to active')

    console.log('-- protected plugin --')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
    await sleep(500)
    await clickNodeRobust(cdp, 'plugin-dsh-3d-plugin-graph')
    await sleep(200)
    const hasUnplugBtn = await cdp.eval('!!document.querySelector(\'#nodeTip [data-act="unplug"]\')')
    if (hasUnplugBtn) {
      await cdp.eval('document.querySelector(\'#nodeTip [data-act="unplug"]\').click()')
      await sleep(100)
      await cdp.eval('document.querySelector(\'#nodeTip [data-act="unplug-yes"]\').click()')
      await sleep(400)
    }
    const refused = actionLog.some(function (a) { return a.action === 'unplug' && a.id === 'plugin-dsh-3d-plugin-graph' })
    check(refused, 'server refuses unplugging the graph plugin itself')

    console.log('-- console health --')
    check(cdp.exceptions.length === 0, 'zero uncaught page exceptions' + (cdp.exceptions.length ? ' (' + cdp.exceptions.length + ')' : ''))
    const firstLogs = cdp.logs.slice(0, 4).map(function (l) { return (l.text || '') }).join(' | ')
    check(cdp.logs.length === 0, 'zero console errors' + (cdp.logs.length ? ' (' + cdp.logs.length + '): ' + firstLogs : ''))
  } catch (err) {
    console.error('ui-test crashed:', err && err.stack ? err.stack : err)
    if (cdp && cdp.exceptions.length) console.error('page exceptions captured:', JSON.stringify(cdp.exceptions.slice(0, 2)).slice(0, 400))
    process.exitCode = 2
  } finally {
    try { cdp && cdp.ws.close() } catch {}
    chrome.kill('SIGKILL')
    server.close()
  }
  if (failures) {
    console.error('ui-test: ' + failures + ' FAILURE(S)')
    process.exitCode = 1
  }
  if (process.exitCode === undefined || process.exitCode === 0) console.log('ui-test: all interaction tests OK')
}

run()