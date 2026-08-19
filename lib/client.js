/**
 * dsh-3d-plugin-graph browser client (ModuleLoader bundle format).
 *
 * Registers through window.__ModuleLoader__.load so the DSH client-modules
 * loader can import it. Adds a floating launcher into the DSH web shell:
 * - button toggles the graph panel
 * - panel has a header (title / refresh / open in new tab / close)
 * - ESC closes the panel; open state persists in sessionStorage
 */

window.__ModuleLoader__.load({
  id: "dsh-3d-plugin-graph",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var ReactDOM = require("react-dom/client");

    var IFRAME_SRC = "/plugins/dsh-3d-plugin-graph/";
    var PANEL_KEY = "dsh-3d-plugin-graph.open";
    var SANS = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    var MONO = "'SF Mono', ui-monospace, Menlo, Consolas, monospace";

    var launcherStyle = {
      position: "fixed",
      right: "14px",
      bottom: "14px",
      zIndex: 2147483000,
      background: "rgba(14,14,16,.92)",
      color: "#e8e8ea",
      border: "1px solid rgba(255,255,255,.25)",
      borderRadius: "6px",
      padding: "8px 14px",
      fontSize: "11px",
      letterSpacing: ".14em",
      cursor: "pointer",
      fontFamily: SANS,
      boxShadow: "0 8px 24px rgba(0,0,0,.55)",
      transition: "border-color .15s, color .15s"
    };

    var panelStyle = {
      position: "fixed",
      right: "14px",
      bottom: "52px",
      width: "min(960px, calc(100vw - 28px))",
      height: "min(660px, calc(100vh - 84px))",
      zIndex: 2147483000,
      background: "#0b0b0d",
      border: "1px solid rgba(255,255,255,.2)",
      borderRadius: "8px",
      overflow: "hidden",
      boxShadow: "0 24px 70px rgba(0,0,0,.7)",
      display: "flex",
      flexDirection: "column"
    };

    var headerStyle = {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "9px 12px",
      borderBottom: "1px solid rgba(255,255,255,.1)",
      background: "rgba(16,16,18,.9)"
    };

    var headTitleStyle = {
      fontSize: "11px",
      letterSpacing: ".2em",
      color: "#e8e8ea",
      fontFamily: SANS
    };

    var headActionsStyle = {
      display: "flex",
      gap: "6px"
    };

    var headBtnStyle = {
      background: "transparent",
      border: "1px solid rgba(255,255,255,.14)",
      color: "#a0a0a6",
      fontSize: "9px",
      letterSpacing: ".08em",
      padding: "4px 9px",
      borderRadius: "4px",
      cursor: "pointer",
      fontFamily: SANS
    };

    function readOpen() {
      try { return sessionStorage.getItem(PANEL_KEY) === "1"; } catch (e) { return false; }
    }
    function writeOpen(v) {
      try { sessionStorage.setItem(PANEL_KEY, v ? "1" : "0"); } catch (e) {}
    }

    function Launcher() {
      var pair = React.useState(readOpen);
      var open = pair[0];
      var setOpen = pair[1];
      var refreshPair = React.useState(0);
      var refreshKey = refreshPair[0];
      var setRefreshKey = refreshPair[1];

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
        null,
        open
          ? React.createElement(
              "div",
              { style: panelStyle },
              React.createElement(
                "div",
                { style: headerStyle },
                React.createElement("span", { style: headTitleStyle }, "DSH · 插件图谱"),
                React.createElement(
                  "div",
                  { style: headActionsStyle },
                  React.createElement("button", {
                    style: headBtnStyle,
                    title: "刷新",
                    onClick: function () { setRefreshKey(function (k) { return k + 1; }); }
                  }, "刷新"),
                  React.createElement("button", {
                    style: headBtnStyle,
                    title: "新窗口打开",
                    onClick: function () { window.open(IFRAME_SRC, "_blank"); }
                  }, "新窗口"),
                  React.createElement("button", {
                    style: headBtnStyle,
                    title: "关闭 (Esc)",
                    onClick: close
                  }, "关闭")
                )
              ),
              React.createElement("iframe", {
                key: refreshKey,
                src: IFRAME_SRC,
                style: { width: "100%", height: "100%", border: 0, display: "block", background: "#0b0b0d", flex: 1 },
                title: "DSH 3D Plugin Graph"
              })
            )
          : null,
        React.createElement(
          "button",
          {
            onClick: toggle,
            style: launcherStyle,
            title: open ? "关闭插件图谱" : "打开插件图谱"
          },
          open ? "关闭图谱" : "插件图谱"
        )
      );
    }

    function apply(ctx) {
      console.log("[dsh-3d-plugin-graph] client apply");
      var host = document.createElement("div");
      host.id = "dsh-3d-plugin-graph-client";
      document.body.appendChild(host);
      var root = ReactDOM.createRoot(host);
      root.render(React.createElement(Launcher));
    }

    exports.name = "dsh-3d-plugin-graph-client";
    exports.inject = [];
    exports.apply = apply;

    return module.exports;
  }
});
