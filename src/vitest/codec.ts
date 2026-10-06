// ページと Bun のあいだで値を JSON で送るための変換。vitest（birpc + flatted）と同じく undefined を保つ。

const UNDEFINED_KEY = "$bwt:undefined";

export function encode(value: unknown, ancestors: object[] = []): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return { [UNDEFINED_KEY]: 1 };
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return value;
  if (ancestors.includes(value)) return "[Circular]";
  if (typeof (value as any).toJSON === "function" && !(value instanceof Error)) {
    return encode((value as any).toJSON(), ancestors);
  }
  ancestors.push(value);
  try {
    if (Array.isArray(value)) return value.map((v) => encode(v, ancestors));
    const out: Record<string, unknown> = {};
    if (value instanceof Error) {
      out.name = value.name;
      out.message = value.message;
      out.stack = value.stack;
      if (value.cause !== undefined) out.cause = encode(value.cause, ancestors);
    }
    for (const k of Object.keys(value)) out[k] = encode((value as any)[k], ancestors);
    return out;
  } finally {
    ancestors.pop();
  }
}

export function decode(value: any): any {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (value[UNDEFINED_KEY] === 1) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) out[k] = decode(value[k]);
    return out;
  }
  return value;
}
