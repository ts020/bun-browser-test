// ページ内のテストランナー。vitest の @vitest/browser/client/tester/tester.ts と runner.ts を
// Bun.WebView 向けに組み直したもの。ランナー・expect・vi・ロケーター・DOM マッチャーは vitest 本体の配布物をそのまま使う。

import "./state";
import { boot, type ModuleEntry } from "./boot";
import { rpc } from "./rpc";
import { getBrowserState, getWorkerState, setTriggerCommand } from "./state";
import { triggerCommand } from "./commands";
import { page, userEvent } from "vitest/browser";
import "./playwright-locators";
// @ts-ignore 配布物を直接読み込む
import "bwt:expect-element";
import { TestRunner } from "vitest";
// @ts-ignore
import { setupCommonEnv, startTests } from "vitest/internal/browser";
import { mapStack } from "./sourcemaps";
import { finishScreenshot, prepareScreenshot } from "./screenshot";
import { BrowserSnapshotEnvironment } from "./snapshot";

setTriggerCommand(triggerCommand);

const state = getWorkerState();
const config = boot.config;

// ---- console / dialog ----

function showPopupWarning<T>(name: string, value: T) {
  return (...params: unknown[]) => {
    const formatted = params.map((p) => JSON.stringify(p)).join(", ");
    console.warn(
      `Vitest encountered a \`${name}(${formatted})\` call that it cannot handle by default, so it returned \`${value}\`. Read more in https://vitest.dev/guide/browser/#thread-blocking-dialogs.`,
    );
    return value;
  };
}
Object.assign(globalThis, {
  alert: showPopupWarning("alert", undefined),
  confirm: showPopupWarning("confirm", false),
  print: showPopupWarning("print", undefined),
  prompt: showPopupWarning("prompt", null),
});

// ---- 未捕捉エラー ----

// vitest の public/error-catcher.js と同じ。どのテストの最中に起きたかを付けて Bun に送る。
function serializeUnhandled(error: unknown) {
  const state = (globalThis as any).__vitest_worker__;
  const VITEST_TEST_NAME = state?.current?.type === "test" ? state.current.name : undefined;
  const VITEST_TEST_PATH = state?.filepath ?? undefined;
  if (typeof error !== "object" || !error) return { message: String(error), VITEST_TEST_NAME, VITEST_TEST_PATH };
  const e = error as Error;
  return {
    name: e.name,
    message: e.message,
    stack: typeof e.stack === "string" ? mapStack(e.stack) : String(e.stack),
    VITEST_TEST_NAME,
    VITEST_TEST_PATH,
  };
}

function reportUnhandled(error: unknown, type: string) {
  return rpc("onUnhandledError", serializeUnhandled(error), type).catch(() => {});
}

/** テスト側が自分で error リスナーを付けていれば、そのエラーは扱われたものとみなす（vitest と同じ）。 */
function catchWindowErrors(errorEvent: string, prop: string, cb: (e: any) => void) {
  let userErrorListenerCount = 0;
  function throwUnhandledError(e: any) {
    if (userErrorListenerCount === 0 && e[prop] != null) {
      cb(e);
    } else {
      // ResizeObserver のように ErrorEvent.error が無く message だけのものもある
      console.error(e.message ? new Error(e.message) : e);
    }
  }
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  add(errorEvent, throwUnhandledError);
  window.addEventListener = function (this: any, ...args: any[]) {
    if (args[0] === errorEvent) userErrorListenerCount++;
    return (add as any)(...args);
  } as any;
  window.removeEventListener = function (this: any, ...args: any[]) {
    if (args[0] === errorEvent && userErrorListenerCount) userErrorListenerCount--;
    return (remove as any)(...args);
  } as any;
}
catchWindowErrors("error", "error", (e: ErrorEvent) => reportUnhandled(e.error, "Error"));
catchWindowErrors("unhandledrejection", "reason", (e: PromiseRejectionEvent) =>
  reportUnhandled(e.reason, "Unhandled Rejection"),
);

// ---- page.viewport ----
// @vitest/browser の page.viewport は BroadcastChannel でオーケストレーターに頼むので、それを受ける。
const channel = new BroadcastChannel(`vitest:${boot.sessionId}`);
channel.addEventListener("message", async (e: MessageEvent) => {
  const data = e.data;
  if (data?.event !== "viewport") return;
  try {
    await rpc("viewport", data.width, data.height);
    // オーケストレーター側の iframe の大きさも合わせる（vitest の setIframeViewport）
    const root = window.frameElement?.ownerDocument.documentElement;
    root?.style.setProperty("--viewport-width", `${data.width}px`);
    root?.style.setProperty("--viewport-height", `${data.height}px`);
    channel.postMessage({ event: "viewport:done", iframeId: data.iframeId });
  } catch (err: any) {
    channel.postMessage({ event: "viewport:fail", iframeId: data.iframeId, error: err.message });
  }
});

// ---- ランナー ----

function toSerializableTask(task: any): any {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    mode: task.mode,
    each: task.each,
    concurrent: task.concurrent,
    fails: task.fails,
    result: task.result,
    tasks: task.tasks?.map(toSerializableTask),
  };
}

const moduleUrls = new Map<string, ModuleEntry>([[boot.testFile.filepath, boot.testFile]]);
for (const setup of boot.setupFiles) moduleUrls.set(setup.filepath, setup);

class BunWebViewTestRunner extends (TestRunner as any) {
  config: any;
  snapshotEnv: BrowserSnapshotEnvironment;

  constructor(options: { config: any }) {
    super(options.config);
    this.config = options.config;
    this.viteEnvironment = "client";
    this.snapshotEnv = options.config.snapshotOptions.snapshotEnvironment;
    this.__setTraces(getBrowserState().traces);
  }

  onBeforeTryTask = async (test: any, options: any) => {
    await (userEvent as any).cleanup();
    await super.onBeforeTryTask?.(test, options);
  };

  onCollectStart = () => {};

  onCollected = async (files: any[]) => {
    await rpc("onCollected", files.map(toSerializableTask));
  };

  // vitest の runner.ts の onTaskFinished と同じ条件で、失敗したテストのスクリーンショットを撮る
  onTaskFinished = async (task: any) => {
    const lastErrorContext = task.result?.errors?.at(-1)?.__vitest_error_context__;
    if (
      !this.config.browser.screenshotFailures ||
      document.body.clientHeight <= 0 ||
      task.result?.state !== "fail" ||
      task.type !== "test" ||
      (lastErrorContext &&
        Reflect.get(lastErrorContext, "assertionName") === "toMatchScreenshot" &&
        Reflect.get(lastErrorContext, "meta")?.outcome !== "unstable-screenshot")
    ) {
      return;
    }
    const file = task.file.filepath as string;
    const path = [
      this.config.attachmentsDir,
      "failure-screenshots",
      file.slice(file.lastIndexOf("/") + 1),
      `${task.fullTestName.replace(/\W/g, "-")}.png`,
    ].join("/");
    try {
      const screenshot = await page.screenshot({
        timeout: this.config.browser.providerOptions?.actionTimeout ?? 5_000,
        path,
      });
      await rpc("failureScreenshot", task.id, screenshot);
    } catch (err) {
      console.error("[vitest] Failed to take a screenshot", err);
    }
  };

  onTaskUpdate = async (packs: any[], events: any[]) => {
    for (const pack of packs) {
      const result = pack[1];
      for (const err of result?.errors ?? []) {
        if (typeof err.stack === "string") err.stack = mapStack(err.stack);
        if (typeof err.stackStr === "string") err.stackStr = mapStack(err.stackStr);
      }
    }
    await rpc("onTaskUpdate", packs, events);
  };

  onTestAnnotate = (_test: any, annotation: any) => Promise.resolve(annotation);
  onTestArtifactRecord = (_test: any, artifact: any) => Promise.resolve(artifact);

  importFile = async (filepath: string, _mode: "collect" | "setup") => {
    const entry = moduleUrls.get(filepath);
    if (!entry) throw new Error(`Unknown module ${filepath}`);
    const url = entry.url;
    try {
      await import(/* @vite-ignore */ url);
    } catch (err) {
      throw new Error(`Failed to import test file ${filepath}`, { cause: err });
    }
  };
}

async function run() {
  // WKWebView では contentWindow.focus() だけでは :focus / hasFocus が有効に
  // ならない。setup / テストを読み込む前に親ページの iframe 要素をフォーカスする。
  (window.frameElement as HTMLElement | null)?.focus();
  const snapshotEnv = new BrowserSnapshotEnvironment();
  config.snapshotOptions.snapshotEnvironment = snapshotEnv;

  state.rpc = state.ctx.rpc = {
    onUserConsoleLog() {},
    onUnhandledError: (err: unknown, type: string) => reportUnhandled(err, type),
    onTaskUpdate() {},
    snapshotSaved() {},
    resolveSnapshotPath: (path: string) => snapshotEnv.resolvePath(path),
  };
  state.onFilterStackTrace = (stack: string) => mapStack(stack);


  const runner = new BunWebViewTestRunner({ config });
  getBrowserState().runner = runner;
  await setupCommonEnv(config);

  state.ctx.files = [{ filepath: boot.testFile.filepath, testLocations: undefined }];
  state.filepath = boot.testFile.filepath;
  try {
    await startTests([{ filepath: boot.testFile.filepath, testLocations: undefined }], runner);
  } catch (err) {
    await reportUnhandled(err, "Run Error");
  }
  try {
    await (userEvent as any).cleanup();
    await Promise.all(getBrowserState().cleanups.map((fn) => fn()));
  } catch (err) {
    await reportUnhandled(err, "Cleanup Error");
  }
  await rpc("onFinished");
}

// Bun 側から呼ぶもの（toMatchScreenshot の撮影の前後など）
const finished = run().catch((err) => reportUnhandled(err, "Run Error"));
Object.assign(globalThis, { __bwt_tester__: { page, prepareScreenshot, finishScreenshot, finished } });
