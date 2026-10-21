import { describe, expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { frameNavigated } from "./cdpBrowserProvider.support.js";

const captureWithFake = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  onTestFinished(() => browser.close());
  const result = await new CdpBrowserProvider().captureScreenshot(
    captureWebScreenshotInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
    }),
  );
  return { browser, result };
};
describe("screenshot committed document identity", () => {
  it.each([
    ["missing screenshot data", {}],
    ["invalid base64 screenshot data", { data: "not base64%%%" }],
  ])("reports %s as a protocol error", async (_label, result) => {
    const { result: observation } = await captureWithFake({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot" ? result : undefined,
    });
    expect(observation).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });

  it.each([
    { offset: 8, value: 14 },
    { offset: 16, value: 0x8000_0000 },
    { offset: 20, value: 0x8000_0000 },
  ])("rejects invalid screenshot IHDR metadata", async ({ offset, value }) => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
      "base64",
    );
    bytes.writeUInt32BE(value, offset);
    const { result } = await captureWithFake({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot"
          ? { data: bytes.toString("base64") }
          : undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });
  it.each(["loader-main", "loader-reloaded"])(
    "distinguishes %s for the same URL",
    async (screenshotDocumentLoader) => {
      const { result } = await captureWithFake({ screenshotDocumentLoader });
      if (screenshotDocumentLoader === "loader-main")
        expect(result.ok).toBe(true);
      else
        expect(result).toMatchObject({
          ok: false,
          error: { reason: "target_changed" },
        });
    },
  );

  it("defers an unidentifiable navigation failure until screenshot cleanup completes", async () => {
    const { browser, result } = await captureWithFake({
      commandEvents: (command) =>
        command.method === "Page.captureScreenshot"
          ? [
              {
                method: "Page.frameNavigated",
                ...(command.sessionId === undefined
                  ? {}
                  : { sessionId: command.sessionId }),
                params: undefined,
              },
            ]
          : undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  });
});

describe("screenshot frame identity transitions", () => {
  it("rejects a self-parented root candidate as malformed identity", async () => {
    const { browser, result } = await captureWithFake({
      commandEvents: (command, origin) =>
        command.method === "Page.captureScreenshot"
          ? [
              frameNavigated(command, {
                id: "candidate-root",
                parentId: "candidate-root",
                url: `${origin}/app?token=frame-secret`,
              }),
            ]
          : undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  });

  it("keeps a malformed known child as screenshot coverage", async () => {
    const { result } = await captureWithFake({
      commandEvents: (command) =>
        command.method === "Page.captureScreenshot"
          ? [
              frameNavigated(command, {
                id: 7,
                parentId: "frame-main",
                url: "https://outside.invalid/child",
              }),
            ]
          : undefined,
    });
    if (!result.ok) throw result.error;
    expect(result.value.completeness.excluded).toContainEqual(
      expect.objectContaining({
        section: "screenshot",
        reason: "invalid_protocol_value",
      }),
    );
  });

  it("detects a same-URL root replacement and scopes later events to its new identity", async () => {
    const { result } = await captureWithFake({
      commandEvents: (command, origin) =>
        command.method === "Page.captureScreenshot"
          ? [
              frameNavigated(command, {
                id: "replacement-main",
                loaderId: "loader-main",
                url: `${origin}/app?token=frame-secret`,
              }),
              {
                method: "Page.navigatedWithinDocument",
                ...(command.sessionId === undefined
                  ? {}
                  : { sessionId: command.sessionId }),
                params: {
                  frameId: "replacement-main",
                  url: "https://outside.invalid/path",
                },
              },
            ]
          : undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "target_not_allowed" },
    });
  });
});

describe("screenshot navigation event applicability", () => {
  it("ignores non-navigation events with selected-frame or malformed parameters", async () => {
    const { result } = await captureWithFake({
      commandEvents: (command) =>
        command.method === "Page.captureScreenshot"
          ? [
              {
                method: "Runtime.consoleAPICalled",
                sessionId: command.sessionId,
                params: {
                  type: "log",
                  args: [],
                  executionContextId: 1,
                  timestamp: 1,
                },
              },
              {
                method: "Page.lifecycleEvent",
                sessionId: command.sessionId,
                params: {
                  frameId: "frame-main",
                  loaderId: "loader-main",
                  name: "DOMContentLoaded",
                  timestamp: 1,
                },
              },
              {
                method: "Runtime.consoleAPICalled",
                sessionId: command.sessionId,
                params: { frameId: "frame-main", args: "not-an-array" },
              },
            ]
          : undefined,
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    "Page.frameRequestedNavigation",
    "Page.navigatedWithinDocument",
  ] as const)("ignores a known non-main frame's %s event", async (method) => {
    const { result } = await captureWithFake({
      commandEvents: (command) =>
        command.method === "Page.captureScreenshot"
          ? [
              {
                method,
                sessionId: command.sessionId,
                params: {
                  frameId: "frame-child",
                  url: "https://outside.invalid/child",
                },
              },
            ]
          : undefined,
    });
    expect(result.ok).toBe(true);
  });
});
