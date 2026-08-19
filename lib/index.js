/**
 * dsh-3d-plugin-graph
 *
 * A DeepSeek Harness bundle plugin: live 3D visualization of the harness
 * plugin space. DSH itself is a composition of plugins, so the graph mirrors
 * the real Cordis runtime instead of demo data.
 *
 * Host side:
 * - serves the standalone 3D Plugin Graph UI at
 *   `/plugins/dsh-3d-plugin-graph/`
 * - serves a live JSON snapshot at
 *   `/plugins/dsh-3d-plugin-graph/state`
 * - accepts a guarded unplug/plug action at
 *   `/plugins/dsh-3d-plugin-graph/action` (POST)
 * - registers the model tool `dsh_plugin_graph_status`
 *
 * Live state comes from four real sources:
 * - `ctx.loader.entries()`  → plugin identity + enabled/disabled + fiber
 * - fiber state machine     → 0 pending / 1 loading / 2 active / 3 error /
 *                             4 disposed / 5 unloading
 * - `ctx.reflect.store`     → service → providing fiber (real dependency edges)
 * - `ctx.tools.schemas()`   → visible tool schema snapshot
 *
 * Compatibility:
 * - Supports both `webServer` (new) and `httpServer` (old) service keys.
 * - Every runtime access is defensive: a headless profile without a web
 *   server, loader, registry, or reflect store still boots and serves a
 *   minimal fallback graph.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-3d-plugin-graph'
export const inject = ['tools']

const HTML_PATH = fileURLToPath(new URL('../assets/index.html', import.meta.url))
let htmlCache = null
const recentRuntimeEvents = []
const MAX_RUNTIME_EVENTS = 80
const MAX_BODY_BYTES = 64 * 1024

/* Fiber state → { id, text } (mirror of the Cordis Fiber state machine). */
const FIBER_STATES = {
  0: { id: 'pending', text: '等待依赖' },
  1: { id: 'loading', text: '加载中' },
  2: { id: 'active', text: '已激活' },
  3: { id: 'error', text: '错误' },
  4: { id: 'disabled', text: '已停用' },
  5: { id: 'unloading', text: '卸载中' },
}

/** Plugins that must never be unplugged from this UI (harness infrastructure). */
const PROTECTED_NAMES = new Set(['loader', 'include', 'isolate', 'cordis-plugin-loader', 'cordis-plugin-include', 'cordis-plugin-isolate', 'dsh-3d-plugin-graph'])

async function getHtml() {
  if (htmlCache === null) {
    htmlCache = await readFile(HTML_PATH, 'utf8')
  }
  return htmlCache
}

function slugify(input) {
  return String(input || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'anon'
}

function pluginIdOf(value) {
  return 'plugin-' + slugify(value)
}

/**
 * Build a live graph snapshot from the real runtime. Never throws: any
 * missing capability falls back to a minimal but valid shape.
 */
function buildState(ctx) {
  const started = Date.now()
  const nodes = []
  const edges = []
  const seenIds = new Set()
  const fiberToPlugin = new Map()
  const serviceProviders = new Map() // service name → Set<pluginId>
  const toolSchemas = []

  const addNode = (raw) => {
    let id = raw.id
    if (seenIds.has(id)) {
      id = id + '-' + slugify(raw.name || 'x').slice(0, 12) + '-' + Math.random().toString(36).slice(2, 6)
    }
    seenIds.add(id)
    const node = {
      id,
      name: raw.name || '未命名插件',
      kind: raw.kind || 'plugin',
      state: raw.state || 'unknown',
      stateText: raw.stateText || '未知',
      injects: [],
      provides: [],
      dependsOn: [],
      dependedBy: [],
      toolCount: 0,
    }
    nodes.push(node)
    if (raw.fiber) {
      /* cordis registry.plugin() returns a *wrapped* fiber (Object.create(raw)); the
         reflect store holds the raw fiber. Map the whole prototype chain. */
      let f = raw.fiber
      for (let depth = 0; f && depth < 4; depth++) {
        if (fiberToPlugin.has(f)) break
        fiberToPlugin.set(f, id)
        f = Object.getPrototypeOf(f)
      }
    }
    return node
  }

  try {
    /* ---- 1. plugin nodes: loader entries (preferred) or registry fallback ---- */
    const loader = ctx.get && ctx.get('loader')
    if (loader && typeof loader.entries === 'function') {
      for (const entry of loader.entries()) {
        if (!entry || !entry.options || entry.options.group) continue
        const opts = entry.options
        const fiber = entry.fiber
        const disabled = entry.disabled === true
        const stateCode = disabled ? 4 : (fiber ? fiber.state : 4)
        const meta = FIBER_STATES[stateCode] || { id: 'unknown', text: '未知' }
        const baseName = opts.name || entry.id || '未命名插件'
        const node = addNode({
          id: pluginIdOf(entry.id || baseName),
          name: baseName,
          kind: 'plugin',
          state: meta.id,
          stateText: meta.text,
          fiber,
        })
        if (fiber && fiber.inject) {
          node.injects = Object.keys(fiber.inject).map((service) => ({ service, provider: null }))
        }
      }
    } else if (ctx.registry && typeof ctx.registry.values === 'function') {
      for (const runtime of [...ctx.registry.values()]) {
        const fiber = runtime && runtime.fibers && runtime.fibers.length ? runtime.fibers[0] : undefined
        const stateCode = fiber ? fiber.state : 4
        const meta = FIBER_STATES[stateCode] || { id: 'unknown', text: '未知' }
        const baseName = (runtime && typeof runtime.name === 'string' && runtime.name.trim()) ? runtime.name : '未命名插件'
        const node = addNode({
          id: pluginIdOf(baseName),
          name: baseName,
          kind: 'plugin',
          state: meta.id,
          stateText: meta.text,
          fiber,
        })
        if (fiber && fiber.inject) {
          node.injects = Object.keys(fiber.inject).map((service) => ({ service, provider: null }))
        }
      }
    }

    /* ---- 1b. map every fiber of every registry runtime to its plugin id ---- */
    /* the reflect store carries the *raw* providing fiber while loader entries may
       hold a wrapped fiber - identity differs, so map by runtime membership */
    try {
      if (ctx.registry && typeof ctx.registry.values === 'function') {
        for (const runtime of [...ctx.registry.values()]) {
          if (!runtime || !runtime.fibers) continue
          const list = typeof runtime.fibers.forEach === 'function' ? [...runtime.fibers] : Array.from({ length: runtime.fibers.length }, (_, idx) => runtime.fibers[idx])
          let id = null
          for (const f of list) { const hit = fiberToPlugin.get(f); if (hit) { id = hit; break } }
          if (!id) continue
          for (const f of list) fiberToPlugin.set(f, id)
        }
      }
    } catch { /* registry introspection unavailable */ }

    /* ---- 2. services: real providers from the reflect store ---- */
    if (ctx.reflect && ctx.reflect.store) {
      /* cordis keys the reflect store by isolate *symbols* - Object.keys misses them */
      for (const key of Reflect.ownKeys(ctx.reflect.store)) {
        const impl = ctx.reflect.store[key]
        if (!impl || typeof impl.name !== 'string' || !impl.fiber) continue
        const providerId = impl.fiber.runtime ? (fiberToPlugin.get(impl.fiber) || 'core') : 'core'
        if (!serviceProviders.has(impl.name)) serviceProviders.set(impl.name, new Set())
        serviceProviders.get(impl.name).add(providerId)
      }
    }

    /* ---- 3. resolve injects against providers → real dependency edges ---- */
    for (const node of nodes) {
      for (const inj of node.injects) {
        const providers = serviceProviders.get(inj.service)
        if (providers && providers.size) {
          inj.provider = [...providers].find((pid) => pid !== node.id) || [...providers][0]
        } else {
          inj.provider = 'core' // provided outside the visible plugin set
        }
        if (inj.provider !== node.id) {
          edges.push({ source: node.id, target: inj.provider, kind: 'dependency' })
        }
      }
    }

    /* ---- 4. reverse index + provided-service summaries ---- */
    const consumersOfService = new Map() // service → Set<pluginId>
    for (const node of nodes) {
      for (const inj of node.injects) {
        if (!consumersOfService.has(inj.service)) consumersOfService.set(inj.service, new Set())
        consumersOfService.get(inj.service).add(node.id)
      }
    }
    for (const node of nodes) {
      const ownServices = []
      for (const [service, providers] of serviceProviders) {
        if (providers.has(node.id)) {
          const consumers = [...(consumersOfService.get(service) || [])].filter((cid) => cid !== node.id)
          ownServices.push({ service, consumers })
        }
      }
      ownServices.sort((a, b) => b.consumers.length - a.consumers.length)
      node.provides = ownServices
    }
    for (const edge of edges) {
      const target = nodes.find((n) => n.id === edge.target)
      const source = nodes.find((n) => n.id === edge.source)
      if (target) target.dependedBy.push(edge.source)
      if (source) source.dependsOn.push(edge.target)
    }

    /* ---- 5. tool schemas (global tool surface; per-plugin attribution is
     * not exposed by the runtime, so the core node carries the count) ---- */
    try {
      if (ctx.tools && typeof ctx.tools.schemas === 'function') {
        for (const schema of ctx.tools.schemas()) {
          if (schema && typeof schema.name === 'string') {
            toolSchemas.push({ name: schema.name, description: schema.description || '' })
          }
        }
      }
    } catch { /* headless profile without tool runtime */ }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-3d-plugin-graph] buildState degraded: ${error?.message || error}`)
  }

  /* ---- 6. core node ---- */
  const core = {
    id: 'core',
    name: 'DSH 核心',
    kind: 'core',
    state: 'active',
    stateText: '已激活',
    injects: [],
    provides: [],
    dependsOn: [],
    dependedBy: [],
    toolCount: toolSchemas.length,
  }
  nodes.unshift(core)
  for (const node of nodes) {
    node.dependedBy = [...new Set(node.dependedBy)]
    node.dependsOn = [...new Set(node.dependsOn)]
  }

  /* ---- 7. dedupe edges ---- */
  const edgeSeen = new Set()
  const uniqueEdges = edges.filter((e) => {
    const key = e.source + '→' + e.target
    if (edgeSeen.has(key)) return false
    edgeSeen.add(key)
    return true
  })

  const services = []
  for (const [service, providers] of serviceProviders) {
    services.push({ service, providers: [...providers].sort() })
  }
  services.sort((a, b) => a.service.localeCompare(b.service))

  const counts = {
    plugins: nodes.length - 1,
    active: nodes.filter((n) => n.kind === 'plugin' && n.state === 'active').length,
    tools: toolSchemas.length,
    services: services.length,
    events: recentRuntimeEvents.length,
    ms: Date.now() - started,
  }

  return {
    updatedAt: new Date().toISOString(),
    counts,
    nodes,
    edges: uniqueEdges,
    tools: toolSchemas,
    services,
    runtimeEvents: recentRuntimeEvents.slice(-MAX_RUNTIME_EVENTS),
  }
}

/** Transitive dependents of a plugin + whether a dependency cycle exists. */
function analyzeImpact(state, id) {
  const node = state.nodes.find((n) => n.id === id)
  if (!node || node.kind === 'core') return null
  const dependents = []
  const queue = [id]
  const visited = new Set()
  while (queue.length) {
    const cur = queue.shift()
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const n of state.nodes) {
      if (n.dependsOn.includes(cur) && !visited.has(n.id)) {
        dependents.push(n.id)
        queue.push(n.id)
      }
    }
  }
  /* cycle detection: follow dependsOn from the node back to itself */
  let cycle = false
  const dfs = (cur, stack) => {
    if (cycle) return
    if (stack.has(cur)) { cycle = true; return }
    const n = state.nodes.find((x) => x.id === cur)
    if (!n) return
    stack.add(cur)
    for (const next of n.dependsOn) if (next !== cur) dfs(next, stack)
    stack.delete(cur)
  }
  dfs(id, new Set())
  return {
    dependents: dependents.filter((d) => d !== id),
    cycle,
    protected: PROTECTED_NAMES.has(String(node.name).toLowerCase()) || node.id === 'core',
  }
}

const WEB_SERVER_KEYS = ['webServer', 'httpServer']

export function apply(ctx) {
  /* ---- model tool: live graph snapshot (schema must cover every returned
   * key — an `additionalProperties: false` mismatch breaks tool binding) ---- */
  ctx.tools.register(defineTool({
    name: 'dsh_plugin_graph_status',
    description: '返回当前 DSH 3D Plugin Graph 的插件节点、真实依赖边、服务提供关系与可见工具 schema 快照，用于可视化或排查插件能力结构。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          updatedAt: { type: 'string' },
          counts: {
            type: 'object',
            additionalProperties: false,
            properties: {
              plugins: { type: 'integer' },
              active: { type: 'integer' },
              tools: { type: 'integer' },
              services: { type: 'integer' },
              events: { type: 'integer' },
              ms: { type: 'integer' },
            },
          },
          nodes: { type: 'array' },
          edges: { type: 'array' },
          tools: { type: 'array' },
          services: { type: 'array' },
          runtimeEvents: { type: 'array' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return buildState(ctx)
    },
  }), 'dsh-3d-plugin-graph: status tool')

  /* ---- live tool-execution feed ---- */
  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    try {
      recentRuntimeEvents.push({
        timestamp: Date.now(),
        tool: exec?.name || 'unknown',
        callId: exec?.callId || '',
        isError: result?.isError === true,
      })
      if (recentRuntimeEvents.length > MAX_RUNTIME_EVENTS) recentRuntimeEvents.shift()
    } catch {
      /* never let an observer failure break the tool pipeline */
    }
  }), 'dsh-3d-plugin-graph: runtime events')

  let webRegistered = false

  const registerWeb = () => {
    if (webRegistered) return
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])
    if (!webServer) return
    webRegistered = true

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/plugins/dsh-3d-plugin-graph',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const pathname = url.pathname.replace(/\/+$/, '')
        const sendJson = (status, payload) => {
          try {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            })
            res.end(JSON.stringify(payload))
          } catch { /* client gone */ }
        }

        try {
          if (pathname.endsWith('/action') && (req.method === 'POST' || req.method === 'PUT')) {
            let body = ''
            for await (const chunk of req) {
              body += chunk
              if (body.length > MAX_BODY_BYTES) {
                sendJson(413, { ok: false, error: '请求体过大' })
                return
              }
            }
            let payload
            try { payload = JSON.parse(body || '{}') } catch { payload = {} }
            const action = payload.action
            const id = String(payload.id || '')
            if (action !== 'unplug' && action !== 'plug') {
              sendJson(400, { ok: false, error: '未知操作' })
              return
            }
            const state = buildState(ctx)
            const impact = analyzeImpact(state, id)
            const target = state.nodes.find((n) => n.id === id)
            if (!target) {
              sendJson(404, { ok: false, error: '插件不存在' })
              return
            }
            if (action === 'unplug' && (!impact || impact.protected || impact.dependents.includes('dsh-3d-plugin-graph'))) {
              sendJson(200, {
                ok: false,
                error: impact && impact.protected
                  ? '该插件受保护，禁止从图谱拔出'
                  : '拔出该插件会卸载图谱插件自身，已拒绝',
              })
              return
            }
            /* find the real loader entry by id or name */
            let entry = null
            const loader = ctx.get && ctx.get('loader')
            if (loader && typeof loader.entries === 'function') {
              for (const candidate of loader.entries()) {
                if (!candidate || !candidate.options || candidate.options.group) continue
                const candidateId = pluginIdOf(candidate.id || candidate.options.name)
                if (candidateId === id || candidate.options.name === target.name || candidate.id === id) {
                  entry = candidate
                  break
                }
              }
            }
            if (!entry || typeof entry.update !== 'function') {
              sendJson(501, { ok: false, error: '当前环境不支持插件启停（无 loader）' })
              return
            }
            try {
              await entry.update({ disabled: action === 'unplug' })
            } catch (error) {
              sendJson(500, { ok: false, error: `插件${action === 'unplug' ? '停用' : '启用'}失败: ${error?.message || error}` })
              return
            }
            const fresh = buildState(ctx)
            const freshTarget = fresh.nodes.find((n) => n.id === id)
            sendJson(200, {
              ok: true,
              action,
              id,
              message: action === 'unplug'
                ? `已拔出 ${target.name}${impact && impact.dependents.length ? `，${impact.dependents.length} 个依赖插件随之下线` : ''}`
                : `已重新插入 ${target.name}`,
              impact,
              node: freshTarget || null,
            })
            return
          }

          if (pathname.endsWith('/state')) {
            sendJson(200, buildState(ctx))
            return
          }

          if (pathname === '/plugins/dsh-3d-plugin-graph' || pathname === '/plugins/dsh-3d-plugin-graph/index.html') {
            const html = await getHtml()
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(html)
            return
          }

          if (pathname === '/plugins/dsh-3d-plugin-graph/client.js') {
            const clientCode = await readFile(new URL('./client.js', import.meta.url), 'utf8')
            res.writeHead(200, {
              'content-type': 'text/javascript; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(clientCode)
            return
          }

          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
        } catch (error) {
          try {
            sendJson(500, { ok: false, error: `内部错误: ${error?.message || error}` })
          } catch { /* already closed */ }
        }
      },
    }), 'dsh-3d-plugin-graph: web routes')
  }

  /* The web server may bind after this plugin in concurrent activation. */
  registerWeb()
  for (const key of WEB_SERVER_KEYS) {
    ctx.on('internal/service', (serviceName) => {
      if (serviceName === key) registerWeb()
    })
  }
}
