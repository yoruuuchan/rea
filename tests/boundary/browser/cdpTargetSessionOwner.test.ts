import { createServer } from "node:http";

import { WebSocket, WebSocketServer } from "ws";
import { expect, it, onTestFinished, vi } from "vitest";

import { CdpTargetSessionOwner } from "../../../src/browser/CdpTargetSessionOwner.js";
import type { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it("waits for a late owned handshake and does not close its active peer on retry", async () => {
  const http = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  let port = 0;
  let releaseUpgrade: (() => void) | undefined;
  let upgradeReceived: (() => void) | undefined;
  const received = new Promise<void>((resolve) => {
    upgradeReceived = resolve;
  });
  const allow = new Promise<void>((resolve) => {
    releaseUpgrade = resolve;
  });
  http.on("upgrade", (request, socket, head) => {
    upgradeReceived?.();
    void allow.then(() =>
      webSockets.handleUpgrade(request, socket, head, (webSocket) =>
        webSockets.emit("connection", webSocket, request),
      ),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture did not bind a TCP port");
  port = address.port;
  const owner = new CdpTargetSessionOwner();
  let connecting: Promise<CdpConnection> | undefined;
  onTestFinished(async () => {
    releaseUpgrade?.();
    if (connecting !== undefined) {
      const pendingConnection = await connecting;
      await owner.finish(pendingConnection);
    }
    await owner.close();
    await new Promise<void>((resolve, reject) =>
      webSockets.close((cause) => (cause ? reject(cause) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      http.close((cause) => (cause ? reject(cause) : resolve())),
    );
  });

  connecting = owner.connect(
    `ws://127.0.0.1:${String(port)}/devtools/browser/late`,
    "inspect_web_page",
    {},
    "late-handshake",
  );
  await received;
  const closing = owner.close();
  releaseUpgrade?.();
  const connection = await connecting;
  await owner.finish(connection);
  await closing;
  expect(connection).toBeDefined();
});

it("retries only the failed transport and does not repeat successful child cleanup", async () => {
  const browser = await startFakeCdpBrowser();
  const owner = new CdpTargetSessionOwner();
  let active: CdpConnection | undefined;
  onTestFinished(async () => {
    if (active !== undefined) await owner.finish(active);
    await owner.close();
    await browser.close();
  });
  const failed = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "failed-session",
  );
  active = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "active-peer",
  );
  const close = vi
    .spyOn(WebSocket.prototype, "close")
    .mockImplementationOnce(() => {
      throw new Error("controlled close failure");
    });
  const terminate = vi
    .spyOn(WebSocket.prototype, "terminate")
    .mockImplementation(() => undefined);
  try {
    const failure = await owner.finish(failed).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ProviderCleanupError);
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["failed-session"],
    });
  } finally {
    close.mockRestore();
    terminate.mockRestore();
  }

  await owner.retryPending();
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(1));
  const cleanup = vi.fn(async () => undefined);
  await owner.finish(active, cleanup);
  await owner.retryPending();
  await owner.close();
  expect(cleanup).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Target.closeTarget",
  );
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Browser.close",
  );
});

it("accepts asynchronous terminate success only after the close event", async () => {
  const browser = await startFakeCdpBrowser();
  const owner = new CdpTargetSessionOwner();
  onTestFinished(async () => {
    await owner.close();
    await browser.close();
  });
  const connection = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "forced-close",
  );
  const originalTerminate = WebSocket.prototype.terminate;
  const close = vi
    .spyOn(WebSocket.prototype, "close")
    .mockImplementation(() => undefined);
  const terminate = vi
    .spyOn(WebSocket.prototype, "terminate")
    .mockImplementation(function (this: WebSocket) {
      return originalTerminate.call(this);
    });
  try {
    await owner.finish(connection);
  } finally {
    close.mockRestore();
    terminate.mockRestore();
  }
  await owner.close();
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});
