// vitest のブラウザ用クライアント（@vitest/browser の配布物）が前提にしているグローバル状態を用意する。
// どのモジュールよりも先に評価される必要があるので、ここでは重いモジュールを import しない。
import * as aria from "ivya/aria";
import { boot } from "./boot";
import { rpc } from "./rpc";

type TriggerCommand = (command: string, args: unknown[], error?: Error) => Promise<unknown>;
let trigger: TriggerCommand = () => Promise.reject(new Error("commands are not ready"));

export function setTriggerCommand(fn: TriggerCommand) {
  trigger = fn;
}

const config = boot.config;
// vitest の esm-client-injector.js と同じく、正規表現の設定は文字列で届くので戻す
if (typeof config.testNamePattern === "string") config.testNamePattern = parseRegexp(config.testNamePattern);
if (typeof config.retry?.condition === "string") config.retry.condition = parseRegexp(config.retry.condition);

function parseRegexp(input: string): RegExp {
  const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
  if (!m) return /$^/;
  if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return RegExp(input);
  return new RegExp(m[2]!, m[3]);
}

class EvaluatedModules {
  idToModuleMap = new Map<string, any>();
  fileToModulesMap = new Map<string, Set<any>>();
  urlToIdModuleMap = new Map<string, any>();
  ensureModule(id: string, url: string) {
    let mod = this.idToModuleMap.get(id);
    if (!mod) {
      mod = { id, url, file: id, importers: new Set(), imports: new Set(), evaluated: false, promise: undefined };
      this.idToModuleMap.set(id, mod);
      this.urlToIdModuleMap.set(url, mod);
    }
    return mod;
  }
  getModuleById(id: string) {
    return this.idToModuleMap.get(id);
  }
  getModuleByUrl(url: string) {
    return this.urlToIdModuleMap.get(url);
  }
  getModulesByFile(file: string) {
    return this.fileToModulesMap.get(file);
  }
  invalidateModule() {}
  clear() {
    this.idToModuleMap.clear();
    this.fileToModulesMap.clear();
    this.urlToIdModuleMap.clear();
  }
}

const evaluatedModules = new EvaluatedModules();

/** vitest の esm-client-injector.js の wrapModule。動的 import の完了を vi.dynamicImportSettled() で待てるようにする。 */
function wrapModule<T>(moduleCallback: () => Promise<T>): Promise<T> {
  if (typeof moduleCallback !== "function") return moduleCallback;
  const moduleId = `${Math.random()}`;
  const mod = evaluatedModules.ensureModule(moduleId, moduleId);
  mod.evaluated = false;
  const mocker = (globalThis as any).__vitest_mocker__;
  mod.promise = new Promise<T>((resolve, reject) => {
    Promise.resolve(mocker?.prepare?.()).finally(() => {
      moduleCallback().then(resolve, reject);
    });
  });
  return mod.promise.finally(() => {
    mod.evaluated = true;
    mod.promise = undefined;
    evaluatedModules.idToModuleMap.delete(mod.id);
    evaluatedModules.urlToIdModuleMap.delete(mod.url);
  });
}

const browserState = {
  files: [boot.testFile.filepath],
  runningFiles: [boot.testFile.filepath],
  config,
  provider: boot.provider,
  viteConfig: { root: config.root },
  providedContext: "{}",
  type: "tester",
  method: "run",
  iframeId: boot.sessionId,
  sessionId: boot.sessionId,
  testerId: boot.sessionId,
  disposeExceptionTracker: () => {},
  wrapModule,
  wrapDynamicImport: wrapModule,
  cleanups: [] as Array<() => unknown>,
  activeTraceTaskIds: new Set<string>(),
  browserTraceAttempts: new Map<string, unknown>(),
  traces: createNoopTraces(),
  commands: {
    onCommand() {},
    triggerCommand: (command: string, args: unknown[], error?: Error) => trigger(command, args, error),
  },
  aria,
  cdp: createCdp(),
  runner: undefined as any,
  selectorEngine: undefined as any,
};

const workerState: any = {
  ctx: {
    rpc: null,
    pool: "browser",
    workerId: 1,
    concurrencyId: 1,
    config,
    projectName: "",
    metaEnv: null,
    files: [],
    environment: { name: "browser", options: null },
    providedContext: {},
    invalidates: [],
  },
  onCancel: () => {},
  config,
  environment: {
    name: "browser",
    viteEnvironment: "client",
    setup() {
      throw new Error("Not called in the browser");
    },
  },
  onCleanup: (fn: () => unknown) => browserState.cleanups.push(fn),
  evaluatedModules,
  resolvingModules: new Set(),
  moduleExecutionInfo: new Map(),
  metaEnv: {
    ...boot.metaEnv,
    ...config.env,
    BASE_URL: "/",
    MODE: "test",
    DEV: true,
    PROD: false,
    SSR: false,
  },
  rpc: null,
  durations: { environment: 0, prepare: performance.now(), fetch: 0 },
  providedContext: {},
};

Object.assign(globalThis, {
  __vitest_browser__: true,
  __vitest_browser_runner__: browserState,
  __vitest_worker__: workerState,
});

export function getBrowserState(): typeof browserState {
  return browserState;
}

export function getWorkerState(): any {
  return workerState;
}

function createCdp() {
  const listeners: Record<string, Function[]> = {};
  const assertSupported = () => {
    if (boot.backend === "firefox") throw new Error("CDP is not supported by the firefox backend. Use the chrome backend for CDP.");
  };
  const cdp = {
    send(method: string, params?: Record<string, unknown>) {
      assertSupported();
      return rpc("cdp", method, params);
    },
    on(event: string, listener: (payload: any) => void) {
      assertSupported();
      (listeners[event] ??= []).push(listener);
      rpc("cdpListen", event).catch(() => {});
      return cdp;
    },
    once(event: string, listener: (payload: any) => void) {
      const handler = (data: unknown) => {
        listener(data);
        cdp.off(event, handler);
      };
      return cdp.on(event, handler);
    },
    off(event: string, listener: (payload: any) => void) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      return cdp;
    },
    emit(event: string, payload: unknown) {
      for (const l of listeners[event] ?? []) {
        try {
          l(payload);
        } catch (err) {
          window.dispatchEvent(new ErrorEvent("error", { error: err }));
        }
      }
    },
  };
  return cdp;
}

// OpenTelemetry は使わないので、何もしない span を渡す
function createNoopTraces() {
  const span: any = new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : () => span) });
  return {
    $: (_name: string, attrs: any, cb?: (span: unknown) => unknown) => (typeof attrs === "function" ? attrs : cb!)(span),
    startSpan: () => span,
    startContextSpan: () => ({ span, context: {} }),
    getContextFromCarrier: () => ({}),
    getContextCarrier: () => ({}),
    bind: (fn: unknown) => fn,
    recordInitSpan: () => {},
    waitInit: async () => {},
    finish: async () => {},
    flush: async () => {},
    isEnabled: () => false,
  };
}
