import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  ObserveWebSessionInput,
  WebObservationSession,
} from "../domain/browserSession.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { WEB_RUNTIME_LIMITS } from "../domain/webRuntime.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import {
  CdpConnection,
  type CdpEvent,
  type CdpTransportEvent,
} from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { authorizedMainFrame } from "./CdpAuthorizedMainFrame.js";
import {
  allowedSanitizedUrl,
  delayWithCancellation,
  isHttpUrl,
  numberValue,
  recordValue,
  recordsValue,
  cdpStringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { mainFrameUrl } from "./CdpCaptureDocuments.js";
import { isMainFrameNavigation } from "./CdpCaptureEventHelpers.js";
import { cdpTargetEventMatches } from "./CdpTargetEvents.js";

interface ObservationContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: ObserveWebSessionInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

type EndReason = WebObservationSession["window"]["end_reason"];
type TimelineEvent = WebObservationSession["timeline"][number];

interface TimelineEntryOptions {
  readonly type: TimelineEvent["type"];
  readonly params: UnknownRecord;
  readonly timestamp?: number | null;
  readonly rawUrl?: string | null;
  readonly requestId?: string | null;
  readonly detail?: string | null;
}

/** Observe external user actions without rejecting approved same-origin navigation. */
export const observeCdpSession = async (
  context: ObservationContext,
): Promise<WebObservationSession> => {
  const allowedOrigins = new Set(context.input.allowed_origins);
  const initial = await authorizedMainFrame({
    connection: context.connection,
    sessionId: context.sessionId,
    signal: context.signal,
    allowedOrigins,
    operation: "observe_web_session",
  });
  const initialUrl = mainFrameUrl(initial) ?? "";
  const mainFrameId = frameId(initial);
  if (mainFrameId === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const capture = new TimelineCapture(allowedOrigins, mainFrameId, initialUrl);
  let removeListener = (): void => {};
  const removeDisconnectListener = context.connection.onDisconnect(() =>
    capture.targetTerminated(),
  );
  try {
    await context.connection.send(
      "Page.enable",
      {},
      context.sessionId,
      context.signal,
    );
    await context.connection.send(
      "Network.enable",
      {},
      context.sessionId,
      context.signal,
    );
    await context.connection.send(
      "Performance.enable",
      { timeDomain: "timeTicks" },
      context.sessionId,
      context.signal,
    );
    removeListener = context.connection.onEvent((event) => {
      if (cdpTargetEventMatches(event, context.sessionId))
        capture.ingest(event);
    });
    // Host wall time marks command dispatch. The returned browser monotonic
    // timestamp is the authoritative cutoff for timestamped lifecycle facts.
    const armedAt = new Date().toISOString();
    const armTimestamp = performanceTimestamp(
      await context.connection.send(
        "Performance.getMetrics",
        {},
        context.sessionId,
        context.signal,
      ),
    );
    capture.assertPreArmBufferWithinLimit();
    capture.arm(armTimestamp);
    await context.connection.send(
      "Page.setLifecycleEventsEnabled",
      { enabled: true },
      context.sessionId,
      context.signal,
    );
    await context.progress?.report({
      phase: "browser_observation",
      completed: 1,
      total: 2,
      message:
        "Browser observation armed; perform the requested user action now",
    });
    let endReason = await waitForWindow(
      context.input.observation_ms,
      capture,
      context.signal,
    );
    if (endReason === "window_elapsed")
      endReason = await captureFinalUrl(context, capture, allowedOrigins);
    await context.progress?.report({
      phase: "browser_observation",
      completed: 2,
      total: 2,
      message: "Browser observation window ended",
      terminal: true,
    });
    if (capture.scopeExcluded) endReason = "target_left_scope";
    return {
      browser: context.discovery.version,
      target: {
        target_id: context.target.id,
        initial_url: allowedSanitizedUrl(initialUrl, allowedOrigins)?.url ?? "",
        final_url: capture.finalUrl,
      },
      window: {
        armed_at: armedAt,
        ended_at: new Date().toISOString(),
        requested_ms: context.input.observation_ms,
        end_reason: endReason,
      },
      timeline: capture.timeline,
      completeness: capture.completeness.snapshot(),
      limitations: [
        "The timeline begins after REA attaches; earlier navigation and network activity is unavailable.",
        "Only navigation metadata is retained; headers, bodies, cookies, console values, and payloads are not captured by this tool.",
        "An out-of-policy destination ends collection immediately and is recorded without its URL.",
        ...(capture.hasUnknownEventTime
          ? [
              "Timeline rows without a comparable producer timestamp have a null timestamp. Buffered events with unknown timing are retained as context only; they do not establish activity inside the selected observation window.",
            ]
          : []),
      ],
    };
  } finally {
    removeListener();
    removeDisconnectListener();
  }
};

class TimelineCapture {
  readonly timeline: TimelineEvent[] = [];
  readonly completeness = new CdpCaptureCompleteness(["timeline"]);
  finalUrl: string | null;
  #sequence = 0;
  #pendingReload = false;
  #scopeExcluded = false;
  #endReason: EndReason | undefined;
  #armTimestamp: number | undefined;
  #eventsBeforeArm: CdpTransportEvent[] = [];
  #eventsBeforeArmBytes = 0;
  #preArmBufferExceeded = false;
  #hasUnknownEventTime = false;
  readonly #listeners = new Set<(reason: EndReason) => void>();

  constructor(
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly mainFrameId: string,
    initialUrl: string,
  ) {
    this.finalUrl =
      allowedSanitizedUrl(initialUrl, allowedOrigins)?.url ?? null;
  }

  ingest(event: CdpTransportEvent): void {
    if (this.#endReason !== undefined || this.#scopeExcluded) return;
    if (!isTimelineEvent(event.method)) return;
    if (this.#armTimestamp === undefined) {
      this.#bufferBeforeArm(event);
      return;
    }
    this.#ingestArmed(event);
  }

  #ingestArmed(event: CdpTransportEvent, bufferedBeforeArm = false): void {
    if (this.#endReason !== undefined || this.#scopeExcluded) return;
    const params = recordValue(event.params);
    if (params === undefined) return;
    const contextOnly =
      bufferedBeforeArm && hasNoComparableProducerTimestamp(event.method);
    if (contextOnly) this.#hasUnknownEventTime = true;
    switch (event.method) {
      case "Page.frameRequestedNavigation":
        this.#navigationRequested(event, params, contextOnly);
        break;
      case "Page.frameNavigated":
        this.#navigationCommitted(event, params, contextOnly);
        break;
      case "Page.navigatedWithinDocument":
        this.#sameDocument(event, params, contextOnly);
        break;
      case "Network.requestWillBeSent":
        this.#redirect(params, bufferedBeforeArm);
        break;
      case "Network.loadingFailed":
        this.#loadingFailed(params, bufferedBeforeArm);
        break;
      case "Page.lifecycleEvent":
        this.#lifecycle(params);
        break;
      case "Inspector.targetCrashed":
      case "Target.detachedFromTarget":
        this.targetTerminated(params);
        break;
    }
  }

  arm(timestamp: number): void {
    this.#armTimestamp = timestamp;
    // Events can arrive after the browser samples Timestamp but before its
    // command response. Defer interpretation so timestamped facts use the
    // sampled cutoff instead of being lost at the transport boundary.
    const pending = this.#eventsBeforeArm;
    this.#eventsBeforeArm = [];
    this.#eventsBeforeArmBytes = 0;
    for (const event of pending) this.#ingestArmed(event, true);
  }

  assertPreArmBufferWithinLimit(): void {
    if (!this.#preArmBufferExceeded) return;
    this.#eventsBeforeArm = [];
    this.#eventsBeforeArmBytes = 0;
    throw new BrowserObservationError("observe_web_session", "payload_limit", {
      detail: `The retained CDP event buffer exceeded its ${String(WEB_RUNTIME_LIMITS.retainedEventBytes)} byte limit before the observation clock was sampled.`,
    });
  }

  #bufferBeforeArm(event: CdpTransportEvent): void {
    if (this.#preArmBufferExceeded) return;
    // The transport carries the original payload length, so budget admission
    // does not reconstruct or reserialize parsed protocol data.
    const bytes = event.wireBytes;
    if (
      bytes >
      WEB_RUNTIME_LIMITS.retainedEventBytes - this.#eventsBeforeArmBytes
    ) {
      this.#preArmBufferExceeded = true;
      this.#eventsBeforeArm = [];
      this.#eventsBeforeArmBytes = 0;
      return;
    }
    this.#eventsBeforeArm.push(event);
    this.#eventsBeforeArmBytes += bytes;
  }

  onEnd(listener: (reason: EndReason) => void): () => void {
    if (this.#endReason !== undefined) listener(this.#endReason);
    else this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  end(reason: EndReason): void {
    if (this.#endReason !== undefined) return;
    this.#endReason = reason;
    for (const listener of this.#listeners) listener(reason);
    this.#listeners.clear();
  }

  targetTerminated(params: UnknownRecord = {}): void {
    if (this.#endReason !== undefined) return;
    this.#add({
      type: "target_terminated",
      params,
      timestamp: null,
      rawUrl: null,
      requestId: null,
      detail: "target_terminated",
    });
    this.end("target_terminated");
  }

  setFinalUrl(rawUrl: string): void {
    if (this.#scopeExcluded) return;
    const destination = scopedUrl(rawUrl, this.allowedOrigins);
    this.finalUrl = destination.scope === "approved" ? destination.url : null;
  }

  get scopeExcluded(): boolean {
    return this.#scopeExcluded;
  }

  get hasUnknownEventTime(): boolean {
    return this.#hasUnknownEventTime;
  }

  excludeTargetScope(
    reason: "invalid_protocol_value" | "out_of_target_scope",
  ): void {
    if (this.#scopeExcluded) return;
    this.#scopeExcluded = true;
    this.finalUrl = null;
    this.completeness.exclude("timeline", reason);
  }

  #navigationRequested(
    event: CdpEvent,
    params: UnknownRecord,
    contextOnly: boolean,
  ): void {
    if (!isMainFrameNavigation(event, this.mainFrameId)) return;
    const reason = safeDetail(params.reason);
    const rawUrl = cdpStringValue(params.url);
    const destination =
      rawUrl === undefined ? undefined : scopedUrl(rawUrl, this.allowedOrigins);
    if (!contextOnly) this.#pendingReload = reason === "reload";
    this.#add({
      type: "navigation_requested",
      params,
      timestamp: null,
      rawUrl: rawUrl ?? null,
      requestId: null,
      detail: reason,
    });
    if (destination !== undefined) this.#stopIfOutOfScope(destination);
  }

  #navigationCommitted(
    event: CdpEvent,
    params: UnknownRecord,
    contextOnly: boolean,
  ): void {
    const frame = recordValue(params.frame);
    if (!isMainFrameNavigation(event, this.mainFrameId)) return;
    const rawUrl = cdpStringValue(frame?.url);
    const destination = scopedUrl(rawUrl, this.allowedOrigins);
    this.#add({
      type:
        !contextOnly && this.#pendingReload
          ? "same_origin_reload"
          : "navigation_committed",
      params: { ...params, frameId: frame?.id, loaderId: frame?.loaderId },
      timestamp: null,
      rawUrl: rawUrl ?? null,
      requestId: null,
      detail: safeDetail(frame?.transitionType),
    });
    if (this.#stopIfOutOfScope(destination)) return;
    if (contextOnly) return;
    this.#pendingReload = false;
    this.finalUrl = destination.url;
  }

  #sameDocument(
    event: CdpEvent,
    params: UnknownRecord,
    contextOnly: boolean,
  ): void {
    if (!isMainFrameNavigation(event, this.mainFrameId)) return;
    const rawUrl = cdpStringValue(params.url);
    const destination = scopedUrl(rawUrl, this.allowedOrigins);
    this.#add({
      type: "same_document_navigation",
      params,
      timestamp: null,
      rawUrl: rawUrl ?? null,
      requestId: null,
      detail: null,
    });
    if (this.#stopIfOutOfScope(destination)) return;
    if (contextOnly) return;
    this.finalUrl = destination.url;
  }

  #redirect(params: UnknownRecord, bufferedBeforeArm: boolean): void {
    const resourceType = cdpStringValue(params.type);
    if (resourceType !== undefined && resourceType !== "Document") return;
    if (
      cdpStringValue(params.frameId) !== this.mainFrameId ||
      recordValue(params.redirectResponse) === undefined
    )
      return;
    const eventTime = this.#networkEventTime(params, bufferedBeforeArm);
    if (!eventTime.keep) return;
    const request = recordValue(params.request);
    const rawUrl = cdpStringValue(request?.url);
    const destination = scopedUrl(rawUrl, this.allowedOrigins);
    this.#add({
      type: "redirect",
      params,
      ...(eventTime.timestamp === undefined
        ? {}
        : { timestamp: eventTime.timestamp }),
      rawUrl: rawUrl ?? null,
      requestId: cdpStringValue(params.requestId) ?? null,
      detail: null,
    });
    if (this.#stopIfOutOfScope(destination)) return;
  }

  #stopIfOutOfScope(destination: {
    readonly url: string | null;
    readonly scope: "approved" | "outside_policy" | "unsupported";
  }): boolean {
    if (destination.scope === "approved") return false;
    this.excludeTargetScope("out_of_target_scope");
    this.end("target_left_scope");
    return true;
  }

  #loadingFailed(params: UnknownRecord, bufferedBeforeArm: boolean): void {
    const frame = cdpStringValue(params.frameId);
    if (frame !== undefined && frame !== this.mainFrameId) return;
    const eventTime = this.#networkEventTime(params, bufferedBeforeArm);
    if (!eventTime.keep) return;
    this.#add({
      type: "load_failed",
      params,
      ...(eventTime.timestamp === undefined
        ? {}
        : { timestamp: eventTime.timestamp }),
      rawUrl: null,
      requestId: cdpStringValue(params.requestId) ?? null,
      detail: safeNetworkError(params.errorText),
    });
  }

  #networkEventTime(
    params: UnknownRecord,
    bufferedBeforeArm: boolean,
  ): {
    readonly keep: boolean;
    readonly timestamp?: number | null;
  } {
    if (!bufferedBeforeArm) return { keep: true };
    const timestamp = numberValue(params.timestamp);
    if (timestamp === undefined || timestamp < 0) {
      this.completeness.exclude("timeline", "invalid_protocol_value");
      this.#hasUnknownEventTime = true;
      return { keep: true, timestamp: null };
    }
    if (this.#armTimestamp === undefined || timestamp <= this.#armTimestamp)
      return { keep: false, timestamp };
    return { keep: true, timestamp };
  }

  #lifecycle(params: UnknownRecord): void {
    if (cdpStringValue(params.frameId) !== this.mainFrameId) return;
    const timestamp = numberValue(params.timestamp);
    if (
      timestamp === undefined ||
      timestamp < 0 ||
      this.#armTimestamp === undefined
    ) {
      this.completeness.exclude("timeline", "invalid_protocol_value");
      return;
    }
    if (timestamp <= this.#armTimestamp) return;
    this.#add({
      type: "lifecycle",
      params,
      rawUrl: null,
      requestId: null,
      detail: safeDetail(params.name),
    });
  }

  #add(options: TimelineEntryOptions): void {
    const {
      type,
      params,
      rawUrl = null,
      requestId = null,
      detail = null,
    } = options;
    const destination =
      rawUrl == null ? null : scopedUrl(rawUrl, this.allowedOrigins);
    const observedTimestamp = numberValue(params.timestamp);
    const timestamp =
      options.timestamp === undefined ? observedTimestamp : options.timestamp;
    if (
      timestamp === undefined ||
      timestamp === null ||
      (timestamp !== null && timestamp < 0)
    ) {
      this.#hasUnknownEventTime = true;
    }
    if (timestamp !== null && timestamp !== undefined && timestamp < 0) {
      this.completeness.exclude("timeline", "invalid_protocol_value");
    }
    this.#sequence += 1;
    this.timeline.push({
      sequence: this.#sequence,
      type,
      timestamp:
        timestamp === undefined || (timestamp !== null && timestamp < 0)
          ? null
          : timestamp,
      frame_id: boundedId(params.frameId),
      loader_id: boundedId(params.loaderId),
      request_id: requestId ?? null,
      url: destination?.scope === "approved" ? destination.url : null,
      destination_scope: destination?.scope ?? null,
      detail,
    });
  }
}

const performanceTimestamp = (value: unknown): number => {
  const metrics = recordsValue(recordValue(value)?.metrics).filter(
    ({ name }) => name === "Timestamp",
  );
  const timestamp = numberValue(metrics[0]?.value);
  if (metrics.length !== 1 || timestamp === undefined || timestamp < 0)
    throw new BrowserObservationError("observe_web_session", "protocol_error", {
      detail:
        "Performance.getMetrics returned no valid monotonic Timestamp metric.",
    });
  return timestamp;
};

const waitForWindow = async (
  durationMs: number,
  capture: TimelineCapture,
  signal?: AbortSignal,
): Promise<EndReason> =>
  await new Promise<EndReason>((resolve, reject) => {
    const timerController = new AbortController();
    let settled = false;
    let removeEnd = (): void => {};
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      timerController.abort();
      signal?.removeEventListener("abort", onAbort);
      removeEnd();
      complete();
    };
    const finish = (reason: EndReason): void => settle(() => resolve(reason));
    const onAbort = (): void =>
      settle(() => {
        reject(
          new AnalysisCancelledError("observe_web_session", {
            cause: signal?.reason,
          }),
        );
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    if (!settled) removeEnd = capture.onEnd(finish);
    if (settled) return;
    void delayWithCancellation(
      durationMs,
      "observe_web_session",
      timerController.signal,
    ).then(
      () => finish("window_elapsed"),
      (cause: unknown) => settle(() => reject(cause)),
    );
  });

const captureFinalUrl = async (
  context: ObservationContext,
  capture: TimelineCapture,
  allowedOrigins: ReadonlySet<string>,
): Promise<EndReason> => {
  if (capture.scopeExcluded) return "target_left_scope";
  const result = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  if (capture.scopeExcluded) return "target_left_scope";
  const url = mainFrameUrl(result);
  if (
    url !== undefined &&
    allowedSanitizedUrl(url, allowedOrigins) !== undefined
  ) {
    capture.setFinalUrl(url);
    return "window_elapsed";
  }
  capture.excludeTargetScope(
    url === undefined ? "invalid_protocol_value" : "out_of_target_scope",
  );
  return "target_left_scope";
};

const frameId = (result: unknown): string | undefined =>
  cdpStringValue(
    recordValue(recordValue(recordValue(result)?.frameTree)?.frame)?.id,
  );

const hasNoComparableProducerTimestamp = (method: string): boolean =>
  method === "Page.frameRequestedNavigation" ||
  method === "Page.frameNavigated" ||
  method === "Page.navigatedWithinDocument" ||
  method === "Inspector.targetCrashed" ||
  method === "Target.detachedFromTarget";

const isTimelineEvent = (method: string): boolean =>
  hasNoComparableProducerTimestamp(method) ||
  method === "Network.requestWillBeSent" ||
  method === "Network.loadingFailed" ||
  method === "Page.lifecycleEvent";

const scopedUrl = (
  value: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly url: string | null;
  readonly scope: "approved" | "outside_policy" | "unsupported";
} => {
  const allowed = allowedSanitizedUrl(value, allowedOrigins);
  if (allowed !== undefined) return { url: allowed.url, scope: "approved" };
  return isHttpUrl(value)
    ? { url: null, scope: "outside_policy" }
    : { url: null, scope: "unsupported" };
};

const boundedId = (value: unknown): string | null =>
  cdpStringValue(value) ?? null;

const safeDetail = (value: unknown): string | null => {
  const detail = cdpStringValue(value)?.toLowerCase();
  return detail !== undefined && /^[a-z0-9_.:-]{1,100}$/u.test(detail)
    ? detail
    : null;
};

const safeNetworkError = (value: unknown): string | null => {
  const error = cdpStringValue(value);
  return error !== undefined && /^net::ERR_[A-Z0-9_]{1,100}$/u.test(error)
    ? error
    : null;
};
