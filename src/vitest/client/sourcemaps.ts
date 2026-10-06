// ページで読み込んだモジュールのソースマップ。エラーのスタックやインラインスナップショットの位置を元のファイルに戻すのに使う。
// スタックの変換は同期的に行う必要があるので、ソースマップは同期 XHR で取りに行く（Bun 側にキャッシュがあるのですぐ返る）。
// @ts-ignore
import { DecodedMap, getOriginalPosition } from "vitest/internal/browser";

const traceMaps = new Map<string, any>();

function load(pathname: string): any {
  if (traceMaps.has(pathname)) return traceMaps.get(pathname);
  let traceMap: any = null;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${pathname}?bwt-map`, false);
    xhr.send();
    if (xhr.status === 200) {
      const map = JSON.parse(xhr.responseText);
      if (map?.mappings) traceMap = new DecodedMap(map, pathname);
    }
  } catch {}
  traceMaps.set(pathname, traceMap);
  return traceMap;
}

function toPathname(file: string): string | null {
  if (!/^https?:/.test(file)) return null;
  try {
    const url = new URL(file);
    return url.origin === location.origin ? url.pathname : null;
  } catch {
    return null;
  }
}

/** 配信している URL を元のファイルのパスに直す（/@fs/abs → abs、/rel → root/rel）。 */
export function urlToFile(pathname: string, root: string): string {
  const decoded = decodeURIComponent(pathname);
  if (decoded.startsWith("/@fs/")) return decoded.slice(4);
  return root.replace(/\/$/, "") + decoded;
}

export function originalPosition(file: string, line: number, column: number): { file: string; line: number; column: number } | null {
  const pathname = toPathname(file);
  if (!pathname || pathname.startsWith("/__bwt/")) return null;
  const traceMap = load(pathname);
  if (!traceMap) return null;
  const pos = getOriginalPosition(traceMap, { line, column });
  if (!pos?.source) return null;
  return { file: pos.source, line: pos.line, column: pos.column };
}

/** スタックの中の URL:行:列 を元のファイルの位置に置き換える。 */
export function mapStack(stack: string): string {
  return stack.replace(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/g, (all, url: string, line: string, column: string) => {
    const pos = originalPosition(url, Number(line), Number(column));
    return pos ? `${pos.file}:${pos.line}:${pos.column + 1}` : all;
  });
}
