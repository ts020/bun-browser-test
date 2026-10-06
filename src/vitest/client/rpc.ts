// ページ → Bun の呼び出し。テストが fetch や JSON を差し替えても影響を受けないよう、最初に確保しておく。
import { decode, encode } from "../codec";
import { boot } from "./boot";

const _fetch = globalThis.fetch.bind(globalThis);
const _stringify = JSON.stringify;
const _parse = JSON.parse;

export function serialize(value: unknown): string {
  return _stringify(encode(value));
}

export async function rpc<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const res = await _fetch(boot.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialize({ method, args }),
  });
  const data = _parse(await res.text());
  if (data.error) {
    const err = new Error(data.error.message);
    err.name = data.error.name ?? "Error";
    throw err;
  }
  return decode(data.result) as T;
}
