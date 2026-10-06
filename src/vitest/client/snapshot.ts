// スナップショットファイルの読み書きは Bun 側で行う（vitest の VitestBrowserSnapshotEnvironment と同じ役割）。
import { rpc } from "./rpc";
import { originalPosition } from "./sourcemaps";

export class BrowserSnapshotEnvironment {
  getVersion() {
    return "1";
  }

  getHeader() {
    return `// Vitest Snapshot v${this.getVersion()}, https://vitest.dev/guide/snapshot.html`;
  }

  readSnapshotFile(filepath: string): Promise<string | null> {
    return rpc("readSnapshotFile", filepath);
  }

  readSnapshotFileData(filepath: string): Promise<Record<string, string> | null> {
    return rpc("readSnapshotFileData", filepath);
  }

  saveSnapshotFile(filepath: string, snapshot: string): Promise<void> {
    return rpc("saveSnapshotFile", filepath, snapshot);
  }

  resolvePath(filepath: string): Promise<string> {
    return rpc("resolveSnapshotPath", filepath);
  }

  resolveRawPath(testPath: string, rawPath: string): Promise<string> {
    return rpc("resolveSnapshotRawPath", testPath, rawPath);
  }

  removeSnapshotFile(filepath: string): Promise<void> {
    return rpc("removeSnapshotFile", filepath);
  }

  processStackTrace(stack: { file: string; line: number; column: number }) {
    const pos = originalPosition(stack.file, stack.line, stack.column);
    return pos ? { ...stack, ...pos } : stack;
  }
}
