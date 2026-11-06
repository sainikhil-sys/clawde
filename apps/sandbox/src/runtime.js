// Artifact runtime. Runs inside <iframe sandbox="allow-scripts"> on the sandbox origin: the document has an
// opaque origin, no network (CSP connect-src 'none'), and no access to the Clawde app.
//
// Protocol (window.postMessage, validated on both sides):
//   runtime -> parent  {type: "clawde-artifact:ready"}
//   parent  -> runtime {type: "clawde-artifact:render", kind, source, theme}   (accepted once)
//   runtime -> parent  {type: "clawde-artifact:rendered"} | {type: "clawde-artifact:error", message}
//                      {type: "clawde-artifact:blocked", what}  (a CSP violation, e.g. a network request)
(function () {
  "use strict";

  var PREFIX = "clawde-artifact:";
  var KINDS = ["html", "react", "svg", "markdown", "mermaid", "chart", "javascript"];
  var MAX_SOURCE = 2000000;
  var rendered = false;

  function send(type, extra) {
    var msg = { type: PREFIX + type };
    for (var k in extra || {}) msg[k] = extra[k];
    // The parent is the Clawde UI; our own origin is opaque, so "*" is the only possible target.
    window.parent.postMessage(msg, "*");
  }

  function reportError(err) {
    var message = err && err.message ? err.message : String(err);
    send("error", { message: message.slice(0, 2000) });
  }

  window.addEventListener("error", function (e) {
    reportError(e.error || e.message);
  });
  window.addEventListener("unhandledrejection", function (e) {
    reportError(e.reason);
  });
  document.addEventListener("securitypolicyviolation", function (e) {
    send("blocked", { what: (e.effectiveDirective || e.violatedDirective) + " " + (e.blockedURI || "").slice(0, 200) });
  });

  function loadScript(name) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/vendor/" + name;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error("Couldn't load the bundled library " + name + "."));
      };
      document.head.appendChild(s);
    });
  }

  function showError(container, message) {
    var box = document.createElement("pre");
    box.className = "clawde-error";
    box.textContent = message;
    container.appendChild(box);
  }

  function root() {
    return document.getElementById("root");
  }

  // ---- HTML / SVG: the artifact becomes the whole document ----

  var CDN_REWRITES = [
    [/^https?:\/\/cdn\.tailwindcss\.com/i, "/vendor/tailwind.js"],
    [/@tailwindcss\/browser/i, "/vendor/tailwind.js"],
    [/chart(\.umd)?(\.min)?\.js|\/chart\.js(@[\d.]+)?(\/|$)/i, "/vendor/chart.umd.min.js"],
    [/mermaid/i, "/vendor/mermaid.min.js"],
    [/\/marked/i, "/vendor/marked.umd.js"],
    [/purify/i, "/vendor/purify.min.js"],
  ];

  /** Point well-known CDN scripts at the bundled copies (everything else stays blocked by the CSP). */
  function rewriteCdnScripts(html) {
    return html.replace(/(<script\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi, function (all, a, url, b) {
      if (!/^https?:/i.test(url)) return all;
      for (var i = 0; i < CDN_REWRITES.length; i++) {
        if (CDN_REWRITES[i][0].test(url)) return a + CDN_REWRITES[i][1] + b;
      }
      return all;
    });
  }

  var REPORTER =
    "<script>(function(){var p=function(m){parent.postMessage(m,'*')};" +
    "addEventListener('error',function(e){p({type:'" + PREFIX + "error',message:String(e.error&&e.error.message||e.message).slice(0,2000)})});" +
    "addEventListener('unhandledrejection',function(e){p({type:'" + PREFIX + "error',message:String(e.reason&&e.reason.message||e.reason).slice(0,2000)})});" +
    "document.addEventListener('securitypolicyviolation',function(e){p({type:'" + PREFIX + "blocked',what:(e.effectiveDirective||e.violatedDirective)+' '+String(e.blockedURI||'').slice(0,200)})});" +
    "})();<\/script>";

  function asDocument(source) {
    var html = rewriteCdnScripts(source);
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, function (m) { return m + REPORTER; });
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, function (m) { return m + "<head>" + REPORTER + "</head>"; });
    return "<!doctype html><html><head><meta charset=\"utf-8\">" + REPORTER + "</head><body>" + html + "</body></html>";
  }

  function writeDocument(html) {
    document.open();
    document.write(html);
    document.close();
  }

  function renderHtml(source) {
    writeDocument(asDocument(source));
  }

  function renderSvg(source, theme) {
    var bg = theme === "dark" ? "#1c1b19" : "#ffffff";
    writeDocument(
      "<!doctype html><html><head><meta charset=\"utf-8\">" + REPORTER +
        "<style>html,body{margin:0;background:" + bg + "}body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem;box-sizing:border-box}svg{max-width:100%;height:auto}</style>" +
        "</head><body>" + source + "</body></html>",
    );
  }

  // ---- Libraries rendered into #root ----

  function renderMarkdown(source) {
    return Promise.all([loadScript("marked.umd.js"), loadScript("purify.min.js")]).then(function () {
      var div = document.createElement("article");
      div.className = "clawde-doc";
      div.innerHTML = window.DOMPurify.sanitize(window.marked.parse(source, { gfm: true }));
      root().appendChild(div);
    });
  }

  function renderMermaid(source, theme) {
    return loadScript("mermaid.min.js").then(function () {
      var mermaid = window.mermaid;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default" });
      return mermaid.render("clawde-mermaid", source).then(function (out) {
        var div = document.createElement("div");
        div.className = "clawde-center";
        div.innerHTML = out.svg;
        root().appendChild(div);
      });
    });
  }

  function renderChart(source, theme) {
    var config;
    try {
      config = JSON.parse(source);
    } catch (e) {
      throw new Error("A chart artifact must be a Chart.js configuration in JSON: " + e.message);
    }
    if (!config || typeof config !== "object" || !config.type || !config.data) {
      throw new Error('A chart needs at least "type" and "data" (Chart.js configuration).');
    }
    return loadScript("chart.umd.min.js").then(function () {
      var Chart = window.Chart;
      if (theme === "dark") {
        Chart.defaults.color = "#ece9e3";
        Chart.defaults.borderColor = "#3a3833";
      }
      config.options = config.options || {};
      config.options.maintainAspectRatio = false;
      var wrap = document.createElement("div");
      wrap.className = "clawde-chart";
      var canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      root().appendChild(wrap);
      new Chart(canvas, config);
    });
  }

  function renderJavascript(source) {
    var out = document.createElement("pre");
    out.className = "clawde-console";
    out.setAttribute("aria-label", "Console output");
    root().appendChild(out);
    function line(level, args) {
      var span = document.createElement("span");
      span.className = "log-" + level;
      span.textContent =
        Array.prototype.map
          .call(args, function (a) {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a, null, 2);
            } catch (e) {
              return String(a);
            }
          })
          .join(" ") + "\n";
      out.appendChild(span);
    }
    ["log", "info", "warn", "error", "debug"].forEach(function (level) {
      console[level] = function () {
        line(level === "info" || level === "debug" ? "log" : level, arguments);
      };
    });
    try {
      // eslint-disable-next-line no-new-func
      var result = new Function(source)();
      if (result && typeof result.then === "function") {
        return result.then(
          function () {
            if (!out.childNodes.length) line("log", ["(finished with no output)"]);
          },
          function (e) {
            line("error", [String(e && e.stack ? e.stack : e)]);
          },
        );
      }
      if (!out.childNodes.length) line("log", ["(finished with no output)"]);
    } catch (e) {
      line("error", [String(e && e.stack ? e.stack : e)]);
    }
  }

  function renderReact(source) {
    return Promise.all([loadScript("react.min.js"), loadScript("babel.min.js"), loadScript("tailwind.js")]).then(function () {
      var modules = window.__clawdeModules;
      var code = window.Babel.transform(source + "\n;if (typeof App !== 'undefined' && !module.exports.default) module.exports.default = App;", {
        filename: "artifact.tsx",
        presets: [["react", { runtime: "automatic" }], "typescript"],
        plugins: ["transform-modules-commonjs"],
      }).code;
      var module = { exports: {} };
      function require(name) {
        if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
        // Models often add `import "./App.css"`: there is no such file, so skip it (Tailwind classes still work).
        if (/\.(css|scss|sass|less)$/i.test(name)) {
          send("blocked", { what: "import " + name.slice(0, 100) + " (stylesheet files aren't available; skipped)" });
          return {};
        }
        throw new Error(
          'Can\'t import "' + name + '": artifacts run offline, and only react, react-dom and react/jsx-runtime are available.',
        );
      }
      // eslint-disable-next-line no-new-func
      new Function("require", "module", "exports", "React", code)(require, module, module.exports, modules.react);
      var Component = module.exports.default || module.exports.App;
      if (typeof Component !== "function") {
        throw new Error("Export a component (export default function App() { ... }) so it can be shown.");
      }
      var React = modules.react;
      class Boundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }
        static getDerivedStateFromError(error) {
          return { error: error };
        }
        componentDidCatch(error) {
          reportError(error);
        }
        render() {
          if (this.state.error) return React.createElement("pre", { className: "clawde-error" }, String(this.state.error.message || this.state.error));
          return this.props.children;
        }
      }
      modules["react-dom/client"].createRoot(root()).render(React.createElement(Boundary, null, React.createElement(Component)));
    });
  }

  function render(kind, source, theme) {
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
    switch (kind) {
      case "html":
        return renderHtml(source);
      case "svg":
        return renderSvg(source, theme);
      case "markdown":
        return renderMarkdown(source);
      case "mermaid":
        return renderMermaid(source, theme);
      case "chart":
        return renderChart(source, theme);
      case "javascript":
        return renderJavascript(source);
      case "react":
        return renderReact(source);
    }
  }

  window.addEventListener("message", function (event) {
    // Only the embedding page may drive the runtime, and only once.
    if (event.source !== window.parent || rendered) return;
    var data = event.data;
    if (!data || data.type !== PREFIX + "render") return;
    if (KINDS.indexOf(data.kind) === -1 || typeof data.source !== "string" || data.source.length > MAX_SOURCE) {
      reportError(new Error("Invalid artifact."));
      return;
    }
    rendered = true;
    var kind = data.kind;
    try {
      var result = render(kind, data.source, data.theme);
      // html/svg replaced this document; their own reporter takes over from here.
      if (kind === "html" || kind === "svg") {
        send("rendered");
        return;
      }
      Promise.resolve(result).then(
        function () {
          send("rendered");
        },
        function (e) {
          showError(root(), e && e.message ? e.message : String(e));
          reportError(e);
        },
      );
    } catch (e) {
      showError(root(), e && e.message ? e.message : String(e));
      reportError(e);
    }
  });

  // This script runs in <head>: announce readiness once #root exists.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { send("ready"); });
  else send("ready");
})();
