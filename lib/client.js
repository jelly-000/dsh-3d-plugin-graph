/**
 * dsh-3d-plugin-graph browser client (ModuleLoader bundle format).
 *
 * Registers through window.__ModuleLoader__.load so the DSH client-modules
 * loader can import it. Adds a floating launcher into the DSH web shell:
 * - a small glass icon button (branch glyph) toggles the graph panel
 * - the panel is a liquid-glass card whose tint follows the DSH theme
 * - panel header: refresh / open in new tab / close
 * - ESC closes the panel; open state persists in sessionStorage
 * - relays 解读 questions from the graph panel into the conversation composer
 *   as a draft — the user reviews/edits, sends, and the assistant answers
 *   with live graph data via its own tool
 */

window.__ModuleLoader__.load({
  id: "dsh-3d-plugin-graph",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var ReactDOM = require("react-dom/client");

    var IFRAME_SRC = "/plugins/dsh-3d-plugin-graph/?embed=1";
    var PANEL_KEY = "dsh-3d-plugin-graph.open";

    var CSS = [
      "#dsh-3d-plugin-graph-client{position:fixed;inset:0;pointer-events:none;z-index:2147483000}",
      "#dsh-3d-plugin-graph-client *{box-sizing:border-box}",

      '.pg-root{--pg-ink:#eef0f4;--pg-glass:rgba(26,26,30,.55);--pg-glass-strong:rgba(34,34,40,.72);',
      '--pg-stroke:rgba(255,255,255,.16);--pg-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.10);',
      '--pg-panel-shadow:0 30px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.12);',
      '--pg-veil:rgba(9,9,13,.52);--pg-accent:#7aa2ff;--pg-dim:rgba(238,240,244,.62)}',
      '.pg-theme-light{--pg-ink:#1b1b20;--pg-glass:rgba(255,255,255,.58);--pg-glass-strong:rgba(255,255,255,.8);',
      '--pg-stroke:rgba(20,20,26,.10);--pg-shadow:0 10px 30px rgba(24,26,38,.16),inset 0 1px 0 rgba(255,255,255,.85);',
      '--pg-panel-shadow:0 28px 70px rgba(24,26,38,.22),inset 0 1px 0 rgba(255,255,255,.9);',
      '--pg-veil:rgba(16,16,24,.40);--pg-accent:#3b6bff;--pg-dim:rgba(27,27,32,.62)}',

      ".pg-launcher{position:fixed;right:18px;bottom:18px;width:34px;height:34px;border-radius:50%;",
      "display:grid;place-items:center;padding:0;cursor:pointer;pointer-events:auto;color:var(--pg-ink);",
      "background:var(--pg-glass);border:1px solid var(--pg-stroke);box-shadow:var(--pg-shadow);",
      "backdrop-filter:blur(18px) saturate(180%);-webkit-backdrop-filter:blur(18px) saturate(180%);",
      "transition:transform .18s ease,background .18s ease,box-shadow .18s ease}",
      ".pg-launcher:hover{transform:translateY(-1px) scale(1.06);background:var(--pg-glass-strong)}",
      ".pg-launcher:active{transform:scale(.95)}",
      ".pg-launcher[data-open='1']{background:var(--pg-glass-strong);box-shadow:var(--pg-shadow),0 0 0 1px var(--pg-accent)}",
      ".pg-launcher svg{width:16px;height:16px;display:block}",

      ".pg-panel{position:fixed;right:18px;bottom:62px;width:min(960px,calc(100vw - 36px));height:min(660px,calc(100vh - 96px));",
      "display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;border-radius:22px;",
      "background:var(--pg-glass);border:1px solid var(--pg-stroke);box-shadow:var(--pg-panel-shadow);",
      "backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%)}",
      ".pg-panel::before{content:'';position:absolute;inset:-45%;pointer-events:none;opacity:.34;",
      "background:conic-gradient(from 0deg,transparent 0 58%,var(--pg-accent) 70%,rgba(140,220,255,.85) 76%,transparent 88% 100%);",
      "filter:blur(56px);animation:pg-swirl 26s linear infinite}",
      ".pg-panel::after{content:'';position:absolute;left:-10%;top:-30%;width:70%;height:80%;pointer-events:none;",
      "background:radial-gradient(closest-side,rgba(255,255,255,.22),transparent 72%);filter:blur(10px);opacity:.7}",
      "@keyframes pg-swirl{to{transform:rotate(360deg)}}",
      "@media (prefers-reduced-motion: reduce){.pg-panel::before{animation:none}}",

      ".pg-head{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px 10px 16px;border-bottom:1px solid var(--pg-stroke)}",
      ".pg-title{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.18em;color:var(--pg-ink);opacity:.9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}",
      ".pg-title svg{width:13px;height:13px;opacity:.75}",
      ".pg-actions{display:flex;gap:6px}",
      ".pg-btn{font:inherit;font-size:10px;letter-spacing:.06em;color:var(--pg-dim);background:transparent;cursor:pointer;",
      "border:1px solid var(--pg-stroke);border-radius:999px;padding:4px 11px;transition:color .15s,border-color .15s,background .15s}",
      ".pg-btn:hover{color:var(--pg-ink);border-color:var(--pg-accent);background:var(--pg-glass-strong)}",

      ".pg-body{position:relative;z-index:1;flex:1;min-height:0;margin:0;background:var(--pg-veil)}",
      ".pg-body iframe{width:100%;height:100%;border:0;display:block;background:transparent}"
    ].join("");

    var FORK_SVG = {
      width: 16,
      height: 16,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.7,
      strokeLinecap: "round",
      strokeLinejoin: "round"
    };

    function ForkIcon() {
      return React.createElement(
        "svg",
        FORK_SVG,
        React.createElement("circle", { cx: 5, cy: 12, r: 2.1 }),
        React.createElement("circle", { cx: 19, cy: 6, r: 2.1 }),
        React.createElement("circle", { cx: 19, cy: 18, r: 2.1 }),
        React.createElement("path", { d: "M7.1 12h2.2c2.4 0 3.4-1.7 4.6-3.5C15 6.7 16.5 6 18.9 6" }),
        React.createElement("path", { d: "M7.1 12h2.2c2.4 0 3.4 1.7 4.6 3.5 1.1 1.8 2.6 2.5 5 2.5" })
      );
    }

    function readOpen() {
      try { return sessionStorage.getItem(PANEL_KEY) === "1"; } catch (e) { return false; }
    }
    function writeOpen(v) {
      try { sessionStorage.setItem(PANEL_KEY, v ? "1" : "0"); } catch (e) {}
    }

    /** Read the host page's background luminance so the glass follows the theme. */
    function detectLight() {
      try {
        var probe = document.body;
        var bg = probe ? getComputedStyle(probe).backgroundColor || "" : "";
        var m = bg.match(/[\d.]+/g);
        // A transparent host body carries no signal — fall back to the OS theme.
        if (!m || m.length < 4 || Number(m[3]) === 0) {
          return !(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        }
        var lum = (0.2126 * Number(m[0]) + 0.7152 * Number(m[1]) + 0.0722 * Number(m[2])) / 255;
        return lum > 0.5;
      } catch (e) {
        return false;
      }
    }

    var ASK_EVENT = "pg-ask";
    function composeAsk(detail) {
      var d = detail || {};
      return "请用大白话解释 DSH 插件图谱里的「" + (d.name || "") + "」（" + (d.id || "") + "）：它是干嘛的？它依赖谁、谁又被它依赖？可以用插件图谱工具（dsh_plugin_graph_status）查实时数据后再回答。";
    }

    function Launcher() {
      var pair = React.useState(readOpen);
      var open = pair[0];
      var setOpen = pair[1];
      var refreshPair = React.useState(0);
      var refreshKey = refreshPair[0];
      var setRefreshKey = refreshPair[1];
      var themePair = React.useState(detectLight);
      var light = themePair[0];
      var setLight = themePair[1];

      React.useEffect(function () {
        var timer = setInterval(function () {
          var next = detectLight();
          setLight(function (prev) { return prev === next ? prev : next; });
        }, 2000);
        return function () { clearInterval(timer); };
      }, []);

      var toggle = function () {
        setOpen(function (v) {
          var nv = !v;
          writeOpen(nv);
          return nv;
        });
      };
      var close = function () {
        setOpen(false);
        writeOpen(false);
      };

      React.useEffect(function () {
        if (!open) return;
        function onKey(e) {
          if (e.key === "Escape") close();
        }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [open]);

      return React.createElement(
        "div",
        { className: "pg-root" + (light ? " pg-theme-light" : "") },
        open
          ? React.createElement(
              "div",
              { className: "pg-panel" },
              React.createElement(
                "div",
                { className: "pg-head" },
                React.createElement(
                  "span",
                  { className: "pg-title" },
                  React.createElement(ForkIcon),
                  "插件图谱"
                ),
                React.createElement(
                  "div",
                  { className: "pg-actions" },
                  React.createElement("button", {
                    className: "pg-btn",
                    title: "刷新",
                    onClick: function () { setRefreshKey(function (k) { return k + 1; }); }
                  }, "刷新"),
                  React.createElement("button", {
                    className: "pg-btn",
                    title: "新窗口打开",
                    onClick: function () { window.open(IFRAME_SRC, "_blank"); }
                  }, "新窗口"),
                  React.createElement("button", {
                    className: "pg-btn",
                    title: "关闭 (Esc)",
                    onClick: close
                  }, "关闭")
                )
              ),
              React.createElement(
                "div",
                { className: "pg-body" },
                React.createElement("iframe", {
                  key: refreshKey,
                  src: IFRAME_SRC,
                  title: "DSH 3D Plugin Graph"
                })
              )
            )
          : null,
        React.createElement(
          "button",
          {
            className: "pg-launcher",
            onClick: toggle,
            "data-open": open ? "1" : "0",
            title: open ? "关闭插件图谱" : "打开插件图谱",
            "aria-label": open ? "关闭插件图谱" : "打开插件图谱"
          },
          React.createElement(ForkIcon)
        )
      );
    }

    function apply(ctx) {
      console.log("[dsh-3d-plugin-graph] client apply");
      var style = document.createElement("style");
      style.id = "dsh-3d-plugin-graph-style";
      style.textContent = CSS;
      document.head.appendChild(style);
      var host = document.createElement("div");
      host.id = "dsh-3d-plugin-graph-client";
      document.body.appendChild(host);
      var root = ReactDOM.createRoot(host);
      root.render(React.createElement(Launcher));
      /* debug surface for diagnosing the 解读 relay */
      try { window.__pgClientDebug = { sessions: ctx.sessions, conversation: ctx.conversation, workspaces: ctx.get && ctx.get('workspaces') } } catch (e) {}
      /* 解读: relay the panel's question into the conversation composer as a
       * DRAFT — it lands in the user's input box for them to review, edit and
       * send themselves. The assistant answers with live graph data via its
       * own tool. Session-scoped: ctx.sessions.scope(id) + input facade. */
      window.addEventListener(ASK_EVENT, function (e) {
        var trace = function (step) {
          try { (window.__pgAskTrace = window.__pgAskTrace || []).push(step) } catch (err) {}
        };
        var finish = function (ok, info) {
          trace("finish:" + ok + ":" + (info || ""));
          try { window.dispatchEvent(new CustomEvent("pg-ask-result", { detail: { ok: ok, info: info || "" } })) } catch (err) {}
        };
        trace("evt");
        try {
          if (!ctx.sessions || typeof ctx.sessions.scope !== "function") { finish(false, "会话服务不可用"); return }
          var snap = ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === "function" ? ctx.sessions.list.getSnapshot() : {};
          var sid = snap.current;
          if (!sid) { finish(false, "当前没有打开的会话——先在 DSH 里打开一个会话"); return }
          var scoped = ctx.sessions.scope(sid);
          /* property access on a scoped context is inject-guarded; get() is not */
          var conv = scoped && typeof scoped.get === "function" ? scoped.get("conversation") : null;
          if (!conv || !conv.input || typeof conv.input.for !== "function") { finish(false, "会话输入服务不可用"); return }
          var facade = conv.input.for(scoped);
          if (!facade || !facade.actions || typeof facade.actions.setDraft !== "function") { finish(false, "输入框服务不可用"); return }
          facade.actions.setDraft(composeAsk(e.detail));
          trace("drafted");
          finish(true, "已填入输入框");
        } catch (err) {
          finish(false, err && err.message);
        }
      });
    }

    exports.name = "dsh-3d-plugin-graph-client";
    exports.inject = ["conversation", "sessions"];
    exports.apply = apply;

    return module.exports;
  }
});
