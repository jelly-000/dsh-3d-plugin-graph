#!/usr/bin/env node
/**
 * Offline verification for dsh-3d-plugin-graph.
 *
 * Imports the host entry and applies it to a fake Cordis ctx that mirrors the
 * real runtime surface: loader entries (with fiber states + disabled flags),
 * a registry fallback, a reflect store (service → providing fiber), a
 * webServer, and a tool runtime. Exercises the state route, the HTML route,
 * the client route, the guarded action route, and the model-tool schema
 * contract (every returned key must be declared — an additionalProperties
 * mismatch breaks tool binding).
 */

import { apply, name } from '../lib/index.js'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

let failures = 0
function assert(condition, message) {
  if (!condition) {
    failures++
    console.error(`FAIL ${message}`)
  }
}

/* ---- mock fibers: mirror of Cordis Fiber records ---- */
function makeFiber(pluginName, state, injectMap, isRoot = false) {
  const fiber = {
    name: pluginName,
    state, // 0 pending / 1 loading / 2 active / 3 error / 4 disposed / 5 unloading
    inject: injectMap || {},
  }
  fiber.runtime = isRoot ? null : { name: pluginName, fibers: [fiber] }
  return fiber
}
const rootFiber = makeFiber(null, 2, null, true)
const fiberTools = makeFiber('dsh-tool-cordis', 2, { logger: null, config: null })
const fiberGraph = makeFiber('dsh-3d-plugin-graph', 2, { tools: null })
const fiberBalance = makeFiber('dsh-balance-monitor', 2, { tools: null, logger: null, webServer: null })
const fiberTeams = makeFiber('dsh-agent-teams', 3, { tools: null }) // error state
const fiberWorkflow = makeFiber('dsh-workflow', 0, { tools: null, logger: null }) // pending
const fiberTimer = makeFiber('dsh-timer', 2, { logger: null, config: null })
const fiberWebServer = makeFiber('dsh-web-server', 2, { logger: null })

/* ---- mock loader entries ---- */
const entryUpdates = []
function makeEntry(fiber, opts) {
  const options = { id: opts.id || opts.name, name: opts.name, disabled: opts.disabled || false }
  /* cordis registry.plugin() returns Object.create(raw) - the loader entry holds the wrapped fiber */
  const wrapped = Object.create(fiber)
  return {
    id: options.id,
    options,
    get disabled() { return options.disabled },
    fiber: wrapped,
    async update(patch) {
      entryUpdates.push({ id: options.id, patch })
      if (typeof patch.disabled === 'boolean') options.disabled = patch.disabled
      // simulate the real lifecycle: a disabled entry loses its active fiber
      if (options.disabled) this.fiber = makeFiber(options.name, 4, fiber ? fiber.inject : {})
      else this.fiber = makeFiber(options.name, 2, fiber ? fiber.inject : {})
    },
  }
}
const entries = [
  makeEntry(makeFiber('loader', 2, { logger: null }), { name: 'loader' }),
  makeEntry(fiberWebServer, { name: 'dsh-web-server' }),
  makeEntry(fiberTools, { name: 'dsh-tool-cordis' }),
  makeEntry(fiberGraph, { name: 'dsh-3d-plugin-graph' }),
  makeEntry(fiberBalance, { name: 'dsh-balance-monitor' }),
  makeEntry(fiberTeams, { name: 'dsh-agent-teams' }),
  makeEntry(fiberWorkflow, { name: 'dsh-workflow' }),
  makeEntry(fiberTimer, { name: 'dsh-timer' }),
  makeEntry(makeFiber('dsh-web', 2, { logger: null }), { name: 'dsh-web', disabled: true }),
]

/* ---- mock reflect store: service → providing fiber ---- */
const reflectStore = {
  /* symbol key: cordis registers services under isolate symbols - must be visible */
  [Symbol('isolate-webServer')]: { name: 'webServer', fiber: fiberWebServer },
  logger: { name: 'logger', fiber: rootFiber },
  config: { name: 'config', fiber: rootFiber },
  loader: { name: 'loader', fiber: makeFiber('cordis-plugin-loader', 2, { logger: null }) },
  tools: { name: 'tools', fiber: fiberTools },
  timer: { name: 'timer', fiber: fiberTimer },
}

const registeredTools = []
const ctx = {
  tools: {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
    schemas() {
      return [{ name: 'demo_tool', description: '演示工具' }, { name: 'demo_tool_2', description: '演示工具二' }]
    },
  },
  registry: {
    values() {
      return [fiberWebServer.runtime, fiberTools.runtime, fiberGraph.runtime, fiberBalance.runtime, fiberTeams.runtime, fiberWorkflow.runtime, fiberTimer.runtime].filter(Boolean)
    },
  },
  reflect: { store: reflectStore },
  logger: { warn() {} },
  get(key) {
    if (key === 'loader') {
      return {
        entries() { return entries },
      }
    }
    if (key === 'webServer') {
      return {
        register(route) {
          registrations.push(route)
          return () => {}
        },
      }
    }
    return undefined
  },
  on() {},
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') dispose()
  },
}

const registrations = []
function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body || ''
    },
  }
}
function makeReq(method, url, body) {
  const req = Readable.from([Buffer.from(body || '')])
  req.method = method
  req.url = url
  req.headers = { 'content-length': String((body || '').length) }
  return req
}

apply(ctx)

assert(name === 'dsh-3d-plugin-graph', 'plugin name mismatch')
assert(registeredTools.length === 1, 'plugin should register the status tool')
assert(registrations.length === 1, 'expected exactly one web route')
const route = registrations[0]
assert(route.kind === 'prefix', 'route kind should be prefix')
assert(route.path === '/plugins/dsh-3d-plugin-graph', 'route path mismatch')

/* ---- tool schema contract: every returned key must be declared ---- */
const tool = registeredTools[0]
const declared = new Set(Object.keys(tool.output.schema.properties || {}))
assert(tool.output.schema.additionalProperties === false, 'schema should reject undeclared keys')
assert(declared.has('nodes') && declared.has('edges') && declared.has('tools') && declared.has('runtimeEvents') && declared.has('counts') && declared.has('services') && declared.has('updatedAt'), 'schema should declare every snapshot key')

/* ---- state route ---- */
const stateRes = makeRes()
await route.handler(makeReq('GET', 'http://x/plugins/dsh-3d-plugin-graph/state'), stateRes)
assert(stateRes.status === 200, 'state route should return 200')
const state = JSON.parse(stateRes.body)

// schema completeness: no undeclared top-level key in the payload
for (const key of Object.keys(state)) {
  assert(declared.has(key), `payload key "${key}" must be declared in the tool schema`)
}

assert(Array.isArray(state.nodes) && state.nodes.length > 0, 'state should include nodes')
assert(state.nodes.some((n) => n.id === 'core'), 'state should include the core node')
assert(state.nodes.some((n) => n.name === 'dsh-balance-monitor' && n.state === 'active'), 'loader entries should map to active nodes')
assert(state.nodes.some((n) => n.name === 'dsh-agent-teams' && n.state === 'error'), 'error fibers should surface as error state')
assert(state.nodes.some((n) => n.name === 'dsh-workflow' && n.state === 'pending'), 'pending fibers should surface as pending state')
assert(state.nodes.some((n) => n.name === 'dsh-web' && n.state === 'disabled'), 'disabled entries should surface as disabled state')

// real dependency edges: tools consumers → tools provider, NOT fabricated core→plugin
const hasPluginEdge = state.edges.some((e) => e.source !== 'core' && e.target !== 'core')
assert(hasPluginEdge, 'edges should include real plugin→plugin dependency edges')
const hasSymbolEdge = state.edges.some((e) => e.source === 'plugin-dsh-balance-monitor' && e.target === 'plugin-dsh-web-server')
assert(hasSymbolEdge, 'symbol-keyed reflect services must produce real plugin->plugin edges')
const hasCoreEdge = state.edges.some((e) => e.target === 'core' && e.source === 'plugin-dsh-balance-monitor')
assert(hasCoreEdge, 'plugin injecting a root-provided service should point at core')
assert(state.edges.every((e) => e.source !== e.target), 'no self edges')

// dependency metadata for the popup + impact analysis
const balance = state.nodes.find((n) => n.name === 'dsh-balance-monitor')
assert(balance.injects.some((i) => i.service === 'tools' && i.provider === 'plugin-dsh-tool-cordis'), 'injects should resolve to real providers')
const graphNode = state.nodes.find((n) => n.name === 'dsh-3d-plugin-graph')
assert(graphNode.injects.some((i) => i.service === 'tools'), 'graph node should inject tools')

assert(Array.isArray(state.edges) && state.edges.length > 0, 'state should include edges')
assert(Array.isArray(state.tools) && state.tools.some((t) => t.name === 'demo_tool'), 'state should include real tool schemas')
assert(Array.isArray(state.runtimeEvents), 'state should include runtimeEvents')
assert(state.counts && state.counts.plugins === state.nodes.length - 1, 'counts.plugins should match node count')
assert(typeof state.updatedAt === 'string', 'updatedAt should be a string')

/* ---- action route: unplug/plug with guards ---- */
const guardRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'unplug', id: 'plugin-dsh-3d-plugin-graph' })), guardRes)
assert(guardRes.status === 200 && JSON.parse(guardRes.body).ok === false, 'unplugging the graph plugin itself should be refused gracefully')

const protectRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'unplug', id: 'plugin-loader' })), protectRes)
assert(protectRes.status === 200 && JSON.parse(protectRes.body).ok === false, 'unplugging protected loader infra should be refused gracefully')

const unplugRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'unplug', id: 'plugin-dsh-timer' })), unplugRes)
assert(unplugRes.status === 200, 'unplugging a normal plugin should succeed')
const unplugBody = JSON.parse(unplugRes.body)
assert(unplugBody.ok === true, 'unplug response should be ok')
assert(entryUpdates.some((u) => u.id === 'dsh-timer' && u.patch.disabled === true), 'entry.update should be called with disabled:true')

const plugRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'plug', id: 'plugin-dsh-timer' })), plugRes)
assert(plugRes.status === 200, 'plug should succeed')
assert(entryUpdates.some((u) => u.id === 'dsh-timer' && u.patch.disabled === false), 'entry.update should be called with disabled:false')

const badRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'explode', id: 'plugin-dsh-timer' })), badRes)
assert(badRes.status === 400, 'unknown action should be refused')

/* ---- adversarial: malformed / hostile requests ---- */
// invalid JSON body
const badJsonRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', '{not valid json'), badJsonRes)
assert(badJsonRes.status === 400, 'invalid JSON body should be rejected')

// oversized body (> 64KB cap)
const bigRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', 'x'.repeat(70 * 1024)), bigRes)
assert(bigRes.status === 413, 'oversized body should be rejected')

// unknown plugin id
const unkRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'unplug', id: 'plugin-does-not-exist' })), unkRes)
assert(unkRes.status === 404, 'unknown plugin id should be 404')

// non-string id (object / array coercion must not match anything)
const objRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'unplug', id: { a: 1 } })), objRes)
assert(objRes.status === 404, 'object id must not resolve')

// GET on the action route must not mutate
const getRes = makeRes()
await route.handler(makeReq('GET', 'http://x/plugins/dsh-3d-plugin-graph/action', ''), getRes)
assert(getRes.status === 404, 'GET on action should not mutate')

// double unplug is idempotent (second call still ok, no crash)
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'unplug', id: 'plugin-dsh-timer' })), makeRes())
const dblRes = makeRes()
await route.handler(makeReq('POST', 'http://x/plugins/dsh-3d-plugin-graph/action', JSON.stringify({ action: 'unplug', id: 'plugin-dsh-timer' })), dblRes)
assert(dblRes.status === 200, 'repeated unplug stays idempotent')

// state response carries nosniff
assert(stateRes.headers['x-content-type-options'] === 'nosniff', 'state response must be nosniff')

/* ---- html route ---- */
const htmlRes = makeRes()
await route.handler(makeReq('GET', 'http://x/plugins/dsh-3d-plugin-graph/'), htmlRes)
assert(htmlRes.status === 200, 'html route should return 200')
assert(htmlRes.body.includes('插件图谱'), 'html should contain the UI title')
assert(htmlRes.body.includes('unprojectAtDepth'), 'html should include screen-plane node drag')
assert(htmlRes.body.includes('confirm-zone'), 'html should include the unplug confirmation zone')
assert(htmlRes.body.includes('nodeTip'), 'html should include the popup')
assert(!htmlRes.body.includes('运行中'), 'html must not contain the stale 运行中 status label')

/* ---- client route ---- */
const clientRes = makeRes()
await route.handler(makeReq('GET', 'http://x/plugins/dsh-3d-plugin-graph/client.js'), clientRes)
assert(clientRes.status === 200, 'client route should return 200')
assert(clientRes.body.includes('dsh-3d-plugin-graph-client'), 'client bundle should be served')
assert(clientRes.body.includes('__ModuleLoader__.load'), 'client bundle should use ModuleLoader protocol')

/* ---- html asset sanity ---- */
const htmlPath = fileURLToPath(new URL('../assets/index.html', import.meta.url))
const html = await readFile(htmlPath, 'utf8')
assert(html.includes('unprojectAtDepth'), 'html asset should include unprojectAtDepth')
assert(html.includes('nodeById(drag.nodeId)'), 'drag must resolve nodes by id (closure bug regression)')
assert(html.includes('setPointerCapture'), 'drag should use pointer capture')
assert(html.includes('touch-action:none'), 'graph should disable touch gestures during drag')
assert(html.includes('nodeUnder(sx,sy)'), 'zoom must anchor at the node under the cursor')
assert(html.includes('#f5f6f8'), 'nodes must be white (not black)')
assert(html.includes('color-scheme:dark'), 'dark color scheme must be declared')
assert(html.includes('prefers-reduced-motion'), 'reduced-motion must be honored')
assert(html.includes('zoomLbl'), 'zoom readout must exist')
assert(html.includes('focus-visible'), 'focus-visible rings must exist')
assert(html.includes('aria-live="polite"'), 'toast must be announced politely')
assert(html.includes('id="search"'), 'search box must exist')
assert(html.includes('fuzzyScore'), 'search must be fuzzy (subsequence + normalized)')
assert(html.includes('grabDx:p.x-proj.sx'), 'grab offset must anchor to the press position')
assert(html.includes("hit.setAttribute('r','26')"), 'hit circle must have a real radius')
assert(html.includes('不会自动重新插入'), 'unplug warning must state no auto-reinsertion')
assert(html.includes('id="fx"'), 'fx layer for flow particles must exist')
assert(html.includes('circle.flow-p'), 'flow particles must be small white motes')
assert(html.includes('id="activity" class="open"'), 'activity panel must be open by default to match the lit button')
assert(html.includes('syncActivity'), 'panel/button state must be synced from one source')
assert(html.includes('nt-note'), 'loader/include entries must carry a managed-lifecycle note')
assert(html.includes('pluginPanel'), 'plugin management panel must exist')
assert(html.includes("nm.indexOf('@deepseek-ai/')===0"), 'panel must hide built-in plugins')
assert(html.includes('syncPlugins'), 'panel state must be synced from one source')
assert(html.includes('p-switch'), 'panel must use toggle switches')
assert(html.includes('role=\"switch\"'), 'toggles must be semantic switches')
assert(html.split('path.edge.flow{')[1].split('}')[0].indexOf('fill') === -1, 'flowing edge paths must never carry a fill (lens-blob regression)')
assert(html.includes('projectCam'), 'focus must compute in the target camera frame')
assert(html.includes('sel-in'), 'incoming edges must be highlighted on selection')
assert(html.includes('cycleMembers'), 'cycle members must surface in the impact analysis')

/* ---- registry fallback: no loader, no reflect ---- */
const ctx2 = {
  tools: { register() {}, schemas() { return [] } },
  registry: {
    values() {
      return [
        { name: 'legacy-plugin', fibers: [makeFiber('legacy-plugin', 2, { logger: null })] },
        { name: 'broken-plugin', fibers: [makeFiber('broken-plugin', 3, {})] },
      ]
    },
  },
  get() { return undefined },
  on() {},
  effect(fn) { const d = fn(); if (typeof d === 'function') d() },
  logger: { warn() {} },
}
const regs2 = []
ctx2.get = (key) => key === 'webServer' ? { register(r) { regs2.push(r); return () => {} } } : undefined
apply(ctx2)
const stateRes2 = makeRes()
await regs2[0].handler(makeReq('GET', 'http://x/plugins/dsh-3d-plugin-graph/state'), stateRes2)
assert(stateRes2.status === 200, 'registry fallback state should return 200')
const state2 = JSON.parse(stateRes2.body)
assert(state2.nodes.some((n) => n.name === 'legacy-plugin' && n.state === 'active'), 'registry fallback should surface active plugin')
assert(state2.nodes.some((n) => n.name === 'broken-plugin' && n.state === 'error'), 'registry fallback should surface error plugin')

if (failures) {
  console.error(`verify: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('verify: dsh-3d-plugin-graph OK')