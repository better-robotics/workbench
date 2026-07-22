// Monaco loaded from jsdelivr's AMD bundle — keeps the repo's no-build-step
// rule (Monaco doesn't ship a usable flat ESM build; the AMD `min/vs` bundle
// is the supported CDN path). sw.js caches cross-origin CDN assets
// (isCacheableCrossOrigin), so the ~2 MB payload is a one-time fetch that
// then serves offline.
import { WORKBENCH_DTS, WORKBENCH_DTS_PATH } from "./api-types.js";

const MONACO_VERSION = "0.52.2";
const ROOT = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`;
const BASE = `${ROOT}/vs`;

let _promise = null;

// Resolve with the global `monaco` namespace, loading + configuring it once.
export function loadMonaco() {
  if (_promise) return _promise;
  _promise = new Promise((resolve, reject) => {
    // Cross-origin workers can't be constructed from a CDN URL directly
    // (same-origin policy on Worker()). The standard shim hands Monaco a
    // tiny same-origin data: worker that sets baseUrl then importScripts the
    // real workerMain off the CDN — ~5 lines, the documented pattern.
    window.MonacoEnvironment = {
      getWorkerUrl() {
        // baseUrl is the PARENT of vs/ — the loader inside workerMain
        // resolves 'vs/language/...' against it, so `${ROOT}/` (not
        // `${BASE}/`) avoids a doubled `vs/vs/` path on the language workers.
        const proxy = `self.MonacoEnvironment = { baseUrl: '${ROOT}/' };\n` +
                      `importScripts('${BASE}/base/worker/workerMain.js');`;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(proxy)}`;
      },
    };
    const loader = document.createElement("script");
    loader.src = `${BASE}/loader.js`;
    loader.onload = () => {
      // AMD require, namespaced as `vs`. Monaco's loader defines a global
      // `require`; scope its config to the vs path and pull editor.main.
      window.require.config({ paths: { vs: BASE } });
      window.require(["vs/editor/editor.main"], () => {
        try {
          configure(window.monaco);
          resolve(window.monaco);
        } catch (err) {
          reject(err);
        }
      });
    };
    loader.onerror = () => reject(new Error("Monaco failed to load (offline and not yet cached?)"));
    document.head.appendChild(loader);
  });
  return _promise;
}

let _configured = false;
function configure(monaco) {
  if (_configured) return;
  _configured = true;
  const js = monaco.languages.typescript.javascriptDefaults;
  js.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    allowNonTsExtensions: true,
    lib: ["es2020", "dom"],
  });
  // User scripts run inside an AsyncFunction wrapper (script-runtime.js), so
  // top-level `return` and `await` are legal here even though Monaco parses
  // each file as a standalone script. Silence the three diagnostics that
  // would otherwise squiggle every template: 1108 return-outside-function,
  // 1375 / 1378 top-level-await-needs-module.
  js.setDiagnosticsOptions({ diagnosticCodesToIgnore: [1108, 1375, 1378] });
  // The headline feature: real IntelliSense for the whole script API.
  js.addExtraLib(WORKBENCH_DTS, WORKBENCH_DTS_PATH);
}
