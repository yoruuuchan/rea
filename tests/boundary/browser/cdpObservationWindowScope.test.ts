import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

it("fails closed on an untimestamped cross-origin main-frame commit during clock sampling", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Performance.getMetrics"],
    commandResult: (command) =>
      command.method === "Performance.getMetrics"
        ? { metrics: [{ name: "Timestamp", value: 20 }] }
        : undefined,
    commandEvents: (command) => {
      if (command.method !== "Performance.getMetrics") return undefined;
      return [
        {
          method: "Page.frameNavigated",
          sessionId: command.sessionId,
          params: {
            frame: {
              id: "frame-main",
              loaderId: "outside-loader",
              url: "https://outside.invalid/path",
            },
          },
        },
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "later-in-window-request",
            timestamp: 21,
            type: "Document",
            frameId: "frame-main",
            redirectResponse: { url: `${browser.allowedOrigin}/prior` },
            request: { url: `${browser.allowedOrigin}/later` },
          },
        },
      ];
    },
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
    }),
  );

  if (!result.ok) throw result.error;
  expect(result.value.window.end_reason).toBe("target_left_scope");
  expect(result.value.target.final_url).toBeNull();
  expect(result.value.timeline).toContainEqual(
    expect.objectContaining({
      type: "navigation_committed",
      loader_id: "outside-loader",
      timestamp: null,
      destination_scope: "outside_policy",
      url: null,
    }),
  );
  expect(result.value.timeline).not.toContainEqual(
    expect.objectContaining({ request_id: "later-in-window-request" }),
  );
});

it("fails closed on an untimestamped out-of-scope main-frame request during clock sampling", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Performance.getMetrics"],
    commandResult: (command) =>
      command.method === "Performance.getMetrics"
        ? { metrics: [{ name: "Timestamp", value: 20 }] }
        : undefined,
    commandEvents: (command, origin) => {
      if (command.method !== "Performance.getMetrics") return undefined;
      return [
        {
          method: "Page.frameRequestedNavigation",
          sessionId: command.sessionId,
          params: {
            frameId: "frame-main",
            url: "https://outside.invalid/path",
            reason: "scriptInitiated",
          },
        },
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "later-in-window-request",
            timestamp: 21,
            type: "Document",
            frameId: "frame-main",
            redirectResponse: { url: `${origin}/prior` },
            request: { url: `${origin}/later` },
          },
        },
      ];
    },
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
    }),
  );

  if (!result.ok) throw result.error;
  expect(result.value.window.end_reason).toBe("target_left_scope");
  expect(result.value.timeline).toContainEqual(
    expect.objectContaining({
      type: "navigation_requested",
      timestamp: null,
      destination_scope: "outside_policy",
      url: null,
    }),
  );
  expect(result.value.timeline).not.toContainEqual(
    expect.objectContaining({ request_id: "later-in-window-request" }),
  );
});

it("fails closed on an untimestamped out-of-scope redirect during clock sampling", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Performance.getMetrics"],
    commandResult: (command) =>
      command.method === "Performance.getMetrics"
        ? { metrics: [{ name: "Timestamp", value: 20 }] }
        : undefined,
    commandEvents: (command, origin) => {
      if (command.method !== "Performance.getMetrics") return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "unknown-time-outside-redirect",
            type: "Document",
            frameId: "frame-main",
            redirectResponse: { url: `${origin}/prior` },
            request: { url: "https://outside.invalid/redirected" },
          },
        },
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "later-in-window-request",
            timestamp: 21,
            type: "Document",
            frameId: "frame-main",
            redirectResponse: { url: `${origin}/prior` },
            request: { url: `${origin}/later` },
          },
        },
      ];
    },
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
    }),
  );

  if (!result.ok) throw result.error;
  expect(result.value.window.end_reason).toBe("target_left_scope");
  expect(result.value.target.final_url).toBeNull();
  expect(result.value.timeline).toContainEqual(
    expect.objectContaining({
      type: "redirect",
      request_id: "unknown-time-outside-redirect",
      timestamp: null,
      destination_scope: "outside_policy",
      url: null,
    }),
  );
  expect(result.value.timeline).not.toContainEqual(
    expect.objectContaining({ request_id: "later-in-window-request" }),
  );
});

it.each([
  [
    "Inspector.targetCrashed",
    {
      method: "Inspector.targetCrashed",
      sessionId: "session-1",
      params: {},
    },
  ],
  [
    "Target.detachedFromTarget",
    {
      method: "Target.detachedFromTarget",
      params: { sessionId: "session-1", targetId: "allowed-page" },
    },
  ],
] as const)(
  "ends on buffered untimestamped %s before collecting later events",
  async (_method, terminalEvent) => {
    const browser = await startFakeCdpBrowser({
      eventsBeforeReply: ["Performance.getMetrics"],
      commandResult: (command) =>
        command.method === "Performance.getMetrics"
          ? { metrics: [{ name: "Timestamp", value: 20 }] }
          : undefined,
      commandEvents: (command, origin) => {
        if (command.method !== "Performance.getMetrics") return undefined;
        return [
          terminalEvent,
          {
            method: "Network.requestWillBeSent",
            sessionId: command.sessionId,
            params: {
              requestId: "after-terminal-event",
              timestamp: 21,
              type: "Document",
              frameId: "frame-main",
              redirectResponse: { url: `${origin}/prior` },
              request: { url: `${origin}/later` },
            },
          },
        ];
      },
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("target_terminated");
    expect(result.value.timeline).toContainEqual(
      expect.objectContaining({
        type: "target_terminated",
        timestamp: null,
      }),
    );
    expect(result.value.timeline).not.toContainEqual(
      expect.objectContaining({ request_id: "after-terminal-event" }),
    );
    expect(result.value.limitations).toContain(
      "Timeline rows without a comparable producer timestamp have a null timestamp. Buffered events with unknown timing are retained as context only; they do not establish activity inside the selected observation window.",
    );
  },
);

it("represents absent timeline timestamps as unknown and preserves an observed zero", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        {
          method: "Page.navigatedWithinDocument",
          sessionId: command.sessionId,
          params: {
            frameId: "frame-main",
            url: `${origin}/without-clock-value`,
            navigationType: "historyApi",
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "actual-zero-clock-value",
            frameId: "frame-main",
            errorText: "net::ERR_CONNECTION_REFUSED",
            timestamp: 0,
          },
        },
      ];
    },
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
    }),
  );

  if (!result.ok) throw result.error;
  expect(result.value.timeline).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "same_document_navigation",
        url: `${browser.allowedOrigin}/without-clock-value`,
        timestamp: null,
      }),
      expect.objectContaining({
        type: "load_failed",
        request_id: "actual-zero-clock-value",
        timestamp: 0,
      }),
    ]),
  );
});
