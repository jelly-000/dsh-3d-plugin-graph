# dsh-3d-plugin-graph 架构

## 组成

- `lib/index.js`：Host 插件
  - 注册模型工具 `dsh_plugin_graph_status`（schema 覆盖全部返回键，防止绑定失败）
  - HTTP 路由：`/state`（实时快照）、`/action`（启停，带守卫）、`/`（UI）、`/client.js`
  - 快照组装：loader entries → fiber 状态机 → reflect 服务提供方 → 真实依赖边 → tools schema → 事件流
  - 启停守卫：核心/加载器基建/图谱自身受保护；影响面含图谱自身时拒绝；业务拒绝返回 200 + ok:false
- `lib/client.js`：浏览器客户端（ModuleLoader 协议），右下角浮动入口 + 面板（刷新/新窗口/关闭/Esc）
- `assets/index.html`：单文件 3D 图谱前端（无外部依赖）
- `scripts/verify.mjs`：离线验证（模拟 Cordis 运行时面）
- `scripts/ui-test.mjs`：headless Chrome + CDP 真实交互测试

## 数据流

```
Harness Runtime
  ├─ ctx.loader.entries() ─> 插件节点（身份/启停）
  ├─ fiber.state          ─> 状态（0-5）
  ├─ ctx.reflect.store    ─> 服务提供方（依赖边）
  ├─ fiber.inject         ─> 注入声明（依赖边方向）
  ├─ ctx.tools.schemas()  ─> 工具面
  ├─ tools/result         ─> 实时事件流
  └─ HTTP /state          ─> 3D UI（2s 轮询合并，保留用户拖拽位置）
```

## 关键设计决策

- **拖拽按 id 解析**：DOM 监听器不持有节点对象引用，事件时 `nodeById(dataset.id)` 解析 —— 状态替换后不会指向幽灵对象（历史根因）
- **拖拽与物理隔离**：拖拽中的节点排除碰撞、弹簧与漂移；松手即停，不吸附回弹
- **真实状态**：所有状态/边/服务均来自运行时，无伪造数据；无可访问来源时降级离线演示
- **危险操作分级**：拔出 = 二次确认 + 影响面警告 + 服务端守卫；重新插入 = 单键
- **schema 契约**：工具 output schema 必须覆盖快照全部顶层键（additionalProperties:false 约束）
- **视觉语言（open-design 设计规范）**：白色节点表面；标签 LOD（zoom 阶梯 + 遮挡隐藏 + 8px）；缩放锚定光标下节点深度（修正 panY 符号错误）；单色系 + 锁定状态色；圆角阶梯（4/6/8/10px）；prefers-reduced-motion 降级

## 兼容策略

- Web 服务：`webServer` / `httpServer` 双键回退
- 路由懒注册：无 web 服务时插件照常加载
- 运行时面防御：无 loader/registry/reflect 时自动降级
- 客户端：`dsh.client` / `dshClient` 双 manifest；严格 `__ModuleLoader__.load` 协议