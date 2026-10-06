// service-worker.test.ts（Service Worker があっても vi.mock が効く）の書き換え
import { expect, test, vi } from "vitest";
import { server } from 'vitest/browser'

test.runIf(server.config.name === 'chromium')("Service worker does not break spying", async (t) => {
  const registration = await navigator.serviceWorker.register(
    new URL("./service-worker.js", import.meta.url)
  );
  t.onTestFinished(async () => {
    await registration.unregister()
  })

  await vi.waitFor(() => expect(registration.active?.state).toBe("activated"));
  await navigator.serviceWorker.ready;
  let swResponseMessage = null;
  const messageChannel = new MessageChannel();
  messageChannel.port1.onmessage = (event) => {
    swResponseMessage = event.data;
  };
  registration.active.postMessage({ type: "PING" }, [messageChannel.port2]);
  await vi.waitFor(() => expect(swResponseMessage.type).toBe("PONG"));

  // Send a mocked API request to the service worker
  const response = await fetch("/hello");
  // Assert the service worker intercepted the request
  const responseText = await response.text();
  expect(response.status).toBe(200);
  expect(responseText).toBe("Hello from Service Worker!");

  // Send an import, which will be intercepted by the service worker
  // Verify spying still works after mocking the network with a service worker
  const { actions } = await import("./src/actions");
  vi.spyOn(actions, "plus").mockReturnValue(12345);
  const result = actions.plus(1, 2);
  expect(actions.plus).toHaveBeenCalled();
  expect(result).toBe(12345);
});
