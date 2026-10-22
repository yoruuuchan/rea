import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  CaptureWebScreenshotInput,
  WebScreenshot,
} from "../domain/webScreenshot.js";
import { createWebScreenshotArtifact } from "../domain/webScreenshot.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { cdpFrameIdentity } from "./CdpCaptureEventHelpers.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import {
  allowedSanitizedUrl,
  recordValue,
  cdpStringValue,
  numberValue,
} from "./CdpCaptureValues.js";
import { mainFrameUrl } from "./CdpCaptureDocuments.js";
import { captureFrames } from "./CdpCaptureDocuments.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { decodeCanonicalBase64 } from "../domain/webScreenshot.js";
import { readPngHeaderDimensions } from "../domain/pngHeader.js";

interface ScreenshotContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: CaptureWebScreenshotInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

/** Capture the current viewport without navigation, evaluation, or page mutation. */
export const captureCdpScreenshot = async (
  context: ScreenshotContext,
): Promise<WebScreenshot> => {
  const origins = new Set(context.input.allowed_origins);
  await context.progress?.report({
    phase: "browser_observation",
    completed: 1,
    total: 2,
    message: "Authorizing current screenshot frame",
  });
  await context.connection.send(
    "Page.enable",
    {},
    context.sessionId,
    context.signal,
  );
  const before = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const beforeUrl = mainFrameUrl(before);
  const authorized = allowedSanitizedUrl(beforeUrl, origins);
  const mainFrame = captureFrames(before, origins, 1).items[0];
  if (authorized === undefined || mainFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  const initialFrame = recordValue(
    recordValue(recordValue(before)?.frameTree)?.frame,
  );
  const navigation = {
    changed: false,
    leftScope: false,
    invalidIdentity: false,
    frameId: mainFrame.frame_id,
    url: beforeUrl,
    loaderId: cdpStringValue(initialFrame?.loaderId),
    completeness: new CdpCaptureCompleteness(),
  };
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    observeScreenshotNavigation(event, origins, navigation);
  });
  const assertCurrentDocument = () => {
    if (navigation.invalidIdentity)
      throw new BrowserObservationError("inspect_web_page", "protocol_error");
    if (navigation.leftScope)
      throw new BrowserObservationError(
        "inspect_web_page",
        "target_not_allowed",
      );
    if (navigation.changed)
      throw new BrowserObservationError("inspect_web_page", "target_changed");
  };
  let screenshot: Awaited<ReturnType<typeof captureScreenshotImage>>;
  let after: unknown;
  try {
    const viewport = await readScreenshotViewport(context);
    assertCurrentDocument();
    screenshot = await captureScreenshotImage(context);
    assertCurrentDocument();
    const currentViewport = await readScreenshotViewport(context);
    assertCurrentDocument();
    assertSameViewport(viewport, currentViewport);
    if (!coversViewport(screenshot, currentViewport)) {
      // Refresh geometry before clipping, and reject a moving viewport rather
      // than capture a region that is no longer visible.
      screenshot = await captureScreenshotImage(context, currentViewport.clip);
      assertCurrentDocument();
      const recoveredViewport = await readScreenshotViewport(context);
      assertCurrentDocument();
      assertSameViewport(currentViewport, recoveredViewport);
      if (!coversViewport(screenshot, recoveredViewport))
        throw new BrowserObservationError(
          "inspect_web_page",
          "protocol_error",
          {
            detail:
              "The screenshot does not cover the reported visual viewport.",
          },
        );
    }
    after = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
  } finally {
    removeListener();
  }
  assertCurrentDocument();
  const afterUrl = mainFrameUrl(after);
  if (
    afterUrl !== beforeUrl ||
    allowedSanitizedUrl(afterUrl, origins) === undefined
  )
    throw new BrowserObservationError("inspect_web_page", "target_changed");
  await context.progress?.report({
    phase: "browser_observation",
    completed: 2,
    total: 2,
    message: "Screenshot capture complete",
    terminal: true,
  });
  return {
    browser: context.discovery.version,
    target: {
      target_id: context.target.id,
      url: authorized.url,
      origin: authorized.origin ?? "",
    },
    captured_at: new Date().toISOString(),
    viewport: screenshot.dimensions,
    artifact: createWebScreenshotArtifact(screenshot.bytes),
    completeness: navigation.completeness.snapshot(),
    limitations: [
      "The screenshot contains the visible viewport, including on-screen content.",
      "REA does not scroll, evaluate JavaScript, or capture beyond the current viewport.",
    ],
  };
};

/** Parse CSS clip geometry and device-pixel coverage at their owning boundary. */
const readScreenshotViewport = async (context: ScreenshotContext) => {
  const metrics = recordValue(
    await context.connection.send(
      "Page.getLayoutMetrics",
      {},
      context.sessionId,
      context.signal,
    ),
  );
  const visualViewport = recordValue(metrics?.visualViewport);
  const cssViewport = recordValue(metrics?.cssVisualViewport);
  const pageX = numberValue(cssViewport?.pageX);
  const pageY = numberValue(cssViewport?.pageY);
  const width = numberValue(cssViewport?.clientWidth);
  const height = numberValue(cssViewport?.clientHeight);
  const scale = numberValue(cssViewport?.scale);
  const pixelWidth = numberValue(visualViewport?.clientWidth);
  const pixelHeight = numberValue(visualViewport?.clientHeight);
  const pixelScale = numberValue(visualViewport?.scale);
  if (
    pageX === undefined ||
    pageY === undefined ||
    width === undefined ||
    height === undefined ||
    scale === undefined ||
    pixelWidth === undefined ||
    pixelHeight === undefined ||
    pixelScale !== scale ||
    width <= 0 ||
    height <= 0 ||
    scale <= 0 ||
    pixelWidth <= 0 ||
    pixelHeight <= 0
  )
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  // Keep ordinary surface captures, including their scrollbars and pixel
  // density. The visual viewport excludes scrollbars and supplies only a
  // lower bound on the expected image size, allowing subpixel rounding.
  const minimumWidth = Math.max(1, Math.floor(pixelWidth * scale));
  const minimumHeight = Math.max(1, Math.floor(pixelHeight * scale));
  if (
    !Number.isSafeInteger(minimumWidth) ||
    !Number.isSafeInteger(minimumHeight)
  )
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  return {
    clip: { x: pageX, y: pageY, width, height, scale },
    pixelWidth,
    pixelHeight,
    minimumWidth,
    minimumHeight,
  };
};

type ScreenshotViewport = Awaited<ReturnType<typeof readScreenshotViewport>>;

const coversViewport = (
  image: Awaited<ReturnType<typeof captureScreenshotImage>>,
  viewport: ScreenshotViewport,
) =>
  image.dimensions.width >= viewport.minimumWidth &&
  image.dimensions.height >= viewport.minimumHeight;

const assertSameViewport = (
  before: ScreenshotViewport,
  after: ScreenshotViewport,
): void => {
  if (
    before.clip.x !== after.clip.x ||
    before.clip.y !== after.clip.y ||
    before.clip.width !== after.clip.width ||
    before.clip.height !== after.clip.height ||
    before.clip.scale !== after.clip.scale ||
    before.pixelWidth !== after.pixelWidth ||
    before.pixelHeight !== after.pixelHeight
  )
    throw new BrowserObservationError("inspect_web_page", "target_changed", {
      detail: "The visual viewport changed during screenshot capture.",
    });
};

interface ScreenshotClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** Decode every capture at the same boundary, including a clipped recovery. */
const captureScreenshotImage = async (
  context: ScreenshotContext,
  clip?: ScreenshotClip,
) => {
  const result = recordValue(
    await context.connection.send(
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: clip !== undefined,
        ...(clip === undefined ? {} : { clip }),
      },
      context.sessionId,
      context.signal,
    ),
  );
  const screenshot = decodeScreenshot(result);
  if (screenshot === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  return screenshot;
};

const decodeScreenshot = (
  result: ReturnType<typeof recordValue>,
):
  | {
      readonly bytes: Buffer;
      readonly dimensions: { width: number; height: number };
    }
  | undefined => {
  const encoded = cdpStringValue(result?.data);
  const bytes =
    encoded === undefined ? undefined : decodeCanonicalBase64(encoded);
  if (bytes === undefined) return undefined;
  const dimensions = readPngHeaderDimensions(bytes);
  return dimensions === undefined ? undefined : { bytes, dimensions };
};

const observeScreenshotNavigation = (
  event: CdpEvent,
  origins: ReadonlySet<string>,
  state: {
    changed: boolean;
    leftScope: boolean;
    invalidIdentity: boolean;
    frameId: string;
    url: string | undefined;
    loaderId: string | undefined;
    readonly completeness: CdpCaptureCompleteness;
  },
): void => {
  const identity = cdpFrameIdentity(event, state.frameId);
  if (identity.applicability === "not_applicable") return;
  if (identity.identityIssue !== null || identity.parentIssue !== null) {
    state.completeness.exclude("screenshot", "invalid_protocol_value");
    if (
      identity.selection === "unknown" &&
      identity.parentRelation === "child" &&
      identity.identityIssue !== null
    )
      return;
    state.invalidIdentity = true;
    return;
  }
  if (identity.selection === "unknown") {
    if (identity.parentRelation === "child") return;
    state.completeness.exclude("screenshot", "invalid_protocol_value");
    state.invalidIdentity = true;
    return;
  }
  if (identity.selection === "other" && !identity.isRootReplacement) return;
  const params = recordValue(event.params);
  if (params === undefined) return;
  const frame =
    event.method === "Page.frameNavigated" ? recordValue(params.frame) : params;
  if (
    event.method === "Page.frameNavigated" &&
    !identity.isRootReplacement &&
    state.loaderId !== undefined &&
    state.loaderId !== "" &&
    cdpStringValue(frame?.loaderId) === state.loaderId &&
    cdpStringValue(frame?.url) === state.url
  )
    return;

  state.changed = true;
  if (allowedSanitizedUrl(frame?.url, origins) === undefined)
    state.leftScope = true;
  if (event.method === "Page.frameNavigated") {
    if (identity.isRootReplacement)
      state.frameId = identity.frameId ?? state.frameId;
    state.url = cdpStringValue(frame?.url) ?? state.url;
    state.loaderId = cdpStringValue(frame?.loaderId);
  } else if (event.method === "Page.navigatedWithinDocument") {
    state.url = cdpStringValue(frame?.url) ?? state.url;
  }
};
