// bunfig.toml の [test] preload に入れて使う。
// - expect.element を生やす
// - 各テストの前にページをまっさらに戻す（ブラウザを使ったテストのあとだけ）
// - ページ内で捕まらなかった例外があればテストを失敗させる
// - 最後にブラウザを閉じる
import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { expectElement } from "./expect-element";
import { closeSession, peekSession } from "./session";

(expect as unknown as { element: typeof expectElement }).element = expectElement;

beforeEach(async () => {
  const s = await peekSession();
  if (s && s.dirty && s.config.resetBetweenTests) await s.reset();
});

afterEach(async () => {
  const s = await peekSession();
  if (!s || !s.dirty || !s.config.failOnPageError) return;
  const errors = await s.invoke<{ message: string; stack?: string }[]>("errors").catch(() => []);
  if (errors.length > 0) {
    throw new Error(
      `Uncaught error(s) in the page:\n${errors.map((e) => `  - ${e.stack ?? e.message}`).join("\n")}`,
    );
  }
});

afterAll(async () => {
  await closeSession();
});
