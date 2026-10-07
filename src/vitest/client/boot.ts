// Bun 側がページに埋め込む起動情報（window.__bwt_boot__）。

export interface ModuleEntry {
  /** 元のソースファイルの絶対パス（スナップショットなどの基準） */
  filepath: string;
  /** バンドル済みモジュールの URL */
  url: string;
}

export interface Boot {
  config: any;
  sessionId: string;
  rpcUrl: string;
  platform: string;
  version: string;
  provider: string;
  backend: "chrome" | "webkit" | "firefox";
  commands: string[];
  testFile: ModuleEntry;
  setupFiles: ModuleEntry[];
  /** .env から読んだ VITE_ などの変数 */
  metaEnv: Record<string, string>;
}

export const boot: Boot = (window as any).__bwt_boot__;
