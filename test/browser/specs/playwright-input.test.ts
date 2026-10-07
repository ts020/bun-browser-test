/**
 * Adapted from Playwright v1.58.2 tests/page/page-keyboard.spec.ts and page-mouse.spec.ts.
 * Copyright 2018 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
 * Modified to exercise this project's input adapters with bun:test, without Playwright.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromeBackend } from "../../../src/chrome";
import { detectChromePath } from "../../../src/config";
import { getBrowserModeConfig } from "../../../src/vitest/config";
import { FirefoxView } from "../../../src/vitest/firefox";
import { Input } from "../../../src/vitest/input";

let view: FirefoxView | InstanceType<typeof Bun.WebView>;
let input: FirefoxView["input"] | Input;
beforeAll(async () => {
  if (process.env.BWT_BACKEND === "firefox") {
    view = await FirefoxView.start(getBrowserModeConfig());
    input = view.input;
  } else {
    view = new Bun.WebView({ backend: await chromeBackend(detectChromePath(), process.getuid?.() === 0 ? ["--no-sandbox"] : []) });
    input = new Input(view, "chrome");
  }
}, 30_000);
afterAll(async () => { await view?.close(); });
beforeEach(async () => {
  await view.navigate("data:text/html,<textarea></textarea>");
  await view.evaluate(`(() => {
    document.querySelector('textarea').focus();
    window.events = [];
    for (const type of ['keydown', 'keypress', 'keyup', 'input']) document.addEventListener(type, e => {
      events.push({type, key: e.key, code: e.code, location: e.location, repeat: e.repeat,
        shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, trusted: e.isTrusted});
    });
    return true;
  })()`);
});
const value = () => view.evaluate("document.querySelector('textarea').value");
const lastDown = () => view.evaluate("events.filter(e => e.type === 'keydown').at(-1)");
async function type(text: string) { for (const key of text) await input.press(key); }

test("Playwright: should type into a textarea", async () => {
  const text = 'Hello world. I am the text that was typed!';
  await type(text);
  expect(await value()).toBe(text);
});

test("Playwright: should move with the arrow keys", async () => {
  await type('Hello World!');
  for (let i = 0; i < 'World!'.length; i++) await input.press('ArrowLeft');
  await type('inserted ');
  expect(await value()).toBe('Hello inserted World!');
  await input.keyDown('Shift');
  for (let i = 0; i < 'inserted '.length; i++) await input.press('ArrowLeft');
  await input.keyUp('Shift');
  await input.press('Backspace');
  expect(await value()).toBe('Hello World!');
});

test("Playwright: should not type canceled events", async () => {
  await view.evaluate(`(document.addEventListener('keydown', e => { if (['l', 'o'].includes(e.key)) e.preventDefault(); }), true)`);
  await type('Hello World!');
  expect(await value()).toBe('He Wrd!');
});

for (const [key, expected] of [['+', '+'], ['Shift++', '+'], ['Shift+~', '~'], ['Shift+Digit3', '#']]) {
  test(`Playwright: should press ${key}`, async () => {
    await input.press(key!);
    expect(await value()).toBe(expected);
    expect(await lastDown()).toMatchObject({ key: expected, trusted: true });
  });
}

test("Playwright: should report multiple modifiers", async () => {
  await input.keyDown('Control');
  await input.keyDown('Alt');
  await input.press(';');
  await input.keyUp('Control');
  await input.keyUp('Alt');
  expect(await view.evaluate("events.filter(e => e.type !== 'keypress').map(({type,key,ctrl,alt}) => ({type,key,ctrl,alt}))")).toEqual([
    {type:'keydown',key:'Control',ctrl:true,alt:false},
    {type:'keydown',key:'Alt',ctrl:true,alt:true},
    {type:'keydown',key:';',ctrl:true,alt:true},
    {type:'keyup',key:';',ctrl:true,alt:true},
    {type:'keyup',key:'Control',ctrl:false,alt:true},
    {type:'keyup',key:'Alt',ctrl:false,alt:false},
  ]);
});

test("Playwright: should specify repeat property", async () => {
  await input.keyDown('a');
  expect(await lastDown()).toMatchObject({repeat:false});
  await input.press('a');
  expect(await lastDown()).toMatchObject({repeat:true});
  await input.keyDown('b');
  expect(await lastDown()).toMatchObject({repeat:false});
  await input.keyDown('b');
  expect(await lastDown()).toMatchObject({repeat:true});
  await input.keyUp('b');
  await input.keyDown('a');
  expect(await lastDown()).toMatchObject({repeat:false});
  await input.keyUp('a');
});

for (const [key, code, location] of [['Digit5','Digit5',0], ['ControlLeft','ControlLeft',1], ['ControlRight','ControlRight',2], ['NumpadSubtract','NumpadSubtract',3]]) {
  test(`Playwright: should specify location for ${key}`, async () => {
    await input.press(key as string);
    expect(await lastDown()).toMatchObject({ code, location });
  });
}
for (const key of ['Enter','NumpadEnter','\n','\r']) {
  test(`Playwright: should press Enter (${JSON.stringify(key)})`, async () => {
    await input.press(key);
    expect(await value()).toBe('\n');
    expect(await lastDown()).toMatchObject({ key:'Enter', code:key === 'NumpadEnter' ? key : 'Enter' });
  });
}

test("Playwright: should handle selectAll", async () => {
  await type('some text');
  await input.press('ControlOrMeta+KeyA');
  await input.press('Backspace');
  expect(await value()).toBe('');
});

test("Playwright: should be able to prevent selectAll", async () => {
  await type('some text');
  await view.evaluate(`(document.addEventListener('keydown', e => { if (e.key === 'a' && (e.metaKey || e.ctrlKey)) e.preventDefault(); }), true)`);
  await input.press('ControlOrMeta+KeyA');
  await input.press('Backspace');
  expect(await value()).toBe('some tex');
});

test("Playwright: Meta should not insert text", async () => {
  await type('hello world');
  await input.press('Meta');
  expect(await value()).toBe('hello world');
  expect(await lastDown()).toMatchObject({key:'Meta',code:'MetaLeft',meta:true});
});

test("Playwright: should have correct Escape event order", async () => {
  await input.press('Escape');
  expect(await view.evaluate("events.map(({type,key,code}) => ({type,key,code}))")).toEqual([
    {type:'keydown',key:'Escape',code:'Escape'}, {type:'keyup',key:'Escape',code:'Escape'},
  ]);
});

for (const key of ['Space','Enter']) {
  test(`Playwright: ${key} should activate a button`, async () => {
    await view.evaluate(`(() => {document.body.innerHTML='<button>a11y</button>'; window.clicked=false; const b=document.querySelector('button'); b.onclick=e=>window.clicked=e.isTrusted; b.focus(); return true;})()`);
    await input.press(key);
    expect(await view.evaluate('window.clicked')).toBe(true);
  });
}

for (const count of [1,2]) {
  test(`Playwright: should ${count === 2 ? 'double ' : ''}click the document`, async () => {
    const event = count === 2 ? 'dblclick' : 'click';
    await view.evaluate(`(document.addEventListener('${event}', e => {window.clicked={type:e.type,detail:e.detail,clientX:e.clientX,clientY:e.clientY,isTrusted:e.isTrusted,button:e.button};}), true)`);
    await input.click(50,60,{clickCount:count});
    expect(await view.evaluate('window.clicked')).toEqual({type:event,detail:count,clientX:50,clientY:60,isTrusted:true,button:0});
  });
}

test("Playwright: down and up should generate click", async () => {
  await view.evaluate(`(document.addEventListener('click', e => {window.clicked=[e.clientX,e.clientY,e.isTrusted];}), true)`);
  await input.mouseMove(50,60);
  await input.mouseDown();
  await input.mouseUp();
  expect(await view.evaluate('window.clicked')).toEqual([50,60,true]);
});

test("Playwright: should report correct buttons property", async () => {
  await view.evaluate(`(() => {window.mouseEvents=[]; for (const type of ['mousedown','mouseup']) window.addEventListener(type,e=>mouseEvents.push({type:e.type,button:e.button,buttons:e.buttons})); return true;})()`);
  await input.mouseMove(50,60);
  await input.mouseDown('middle');
  await input.mouseDown('left');
  await input.mouseUp('middle');
  await input.mouseUp('left');
  expect(await view.evaluate('mouseEvents')).toEqual([
    {type:'mousedown',button:1,buttons:4}, {type:'mousedown',button:0,buttons:5},
    {type:'mouseup',button:1,buttons:1}, {type:'mouseup',button:0,buttons:0},
  ]);
});

test("Playwright: should report correct pointerType property", async () => {
  await input.mouseMove(50,60);
  await view.evaluate(`(() => {window.pointerEvents=[]; for (const type of ['pointermove','pointerdown','pointerup']) window.addEventListener(type,e=>pointerEvents.push({type:e.type,pointerType:e.pointerType})); return true;})()`);
  await input.mouseMove(60,50);
  await input.mouseDown();
  await input.mouseUp();
  expect(await view.evaluate('pointerEvents')).toEqual([
    {type:'pointermove',pointerType:'mouse'}, {type:'pointerdown',pointerType:'mouse'}, {type:'pointerup',pointerType:'mouse'},
  ]);
});


test("Playwright: insertText should only emit input event", async () => {
  await input.insertText('hello world');
  expect(await value()).toBe('hello world');
  expect(await view.evaluate("events.map(e => e.type)")).toEqual(['input']);
  expect(await view.evaluate("events[0].trusted")).toBe(true);
});

test("Playwright: insertText should insert non-US characters and emoji", async () => {
  const text = '嗨 👹 Tokyo street Japan 🇯🇵';
  await input.insertText(text);
  expect(await value()).toBe(text);
});
