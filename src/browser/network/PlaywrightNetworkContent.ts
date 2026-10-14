import { createHash } from "node:crypto";

import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import type {
  BrowserNetworkBody,
  BrowserNetworkHeaders,
} from "../../domain/browserNetworkEvidence.js";
import type { BrowserScenarioSecrets } from "../BrowserScenarioSecrets.js";
import { withPlaywrightExecutionBoundary } from "../PlaywrightExecutionBoundary.js";

/** The producer seam for ordered, duplicate-preserving HTTP headers. */
export interface NetworkHeadersSource {
  headers(): Record<string, string>;
  headersArray(): Promise<{ name: string; value: string }[]>;
}

/** A bounded read cannot delay browser cleanup indefinitely. */
export interface NetworkReadOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

const credentialHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

const errorMessage = (
  cause: unknown,
  secrets: BrowserScenarioSecrets,
): string => {
  const message =
    cause instanceof Error && cause.message !== ""
      ? cause.message
      : "Network read failed";
  return secrets.redactionAllocationCost(message.length) <= 1024 * 1024
    ? secrets.redact(message)
    : "Network read failed; diagnostic exceeds the allocation budget.";
};

/** Read actual producer headers without flattening duplicates or exposing credentials. */
export const captureNetworkHeaders = async (
  source: NetworkHeadersSource,
  secrets: BrowserScenarioSecrets,
  options: NetworkReadOptions,
): Promise<BrowserNetworkHeaders> => {
  try {
    const headers = await withPlaywrightExecutionBoundary(
      () => source.headersArray(),
      options.timeoutMs,
      options.signal,
    );
    let cost = 0;
    for (const { name, value } of headers) {
      cost += secrets.redactionAllocationCost(name.length + value.length) + 128;
      if (cost > 1024 * 1024)
        return {
          state: "unavailable",
          message: "Headers exceed the 1 MiB allocation budget.",
        };
    }
    return {
      state: "captured",
      items: headers.map(({ name, value }) => {
        const safeName = secrets.redact(name);
        const credential = credentialHeaders.has(name.toLowerCase());
        const safeValue = credential
          ? null
          : secrets.redactBytes(Buffer.from(value)).toString("utf8");
        return {
          name: safeName,
          value: safeValue,
          redacted: credential || safeName !== name || safeValue !== value,
        };
      }),
    };
  } catch (cause: unknown) {
    return { state: "unavailable", message: errorMessage(cause, secrets) };
  }
};

/** Retain bytes returned by Playwright's body API, after declared-secret redaction. */
export const captureNetworkBody = async (
  read: () => Promise<Buffer | null>,
  phase: "request" | "response",
  source: NetworkHeadersSource,
  secrets: BrowserScenarioSecrets,
  options: NetworkReadOptions,
): Promise<BrowserNetworkBody> => {
  try {
    const observed = await withPlaywrightExecutionBoundary(
      read,
      options.timeoutMs,
      options.signal,
    );
    if (observed === null) return { state: "not_exposed" };
    // This bounds subsequent redaction, base64 and validation copies, but the
    // Playwright API itself has already materialized the body (see PR limits).
    if (observed.length > 64 * 1024)
      return {
        state: "unavailable",
        reason: "body-read-failed",
        message: "Body exceeds the 64 KiB retained-content budget.",
      };
    if (secrets.redactionAllocationCost(observed.length) > 1024 * 1024)
      return {
        state: "unavailable",
        reason: "body-read-failed",
        message: "Body redaction exceeds the allocation budget.",
      };
    const retained = secrets.redactBytes(observed);
    const contentType = source.headers()["content-type"];
    if (
      contentType !== undefined &&
      secrets.redactionAllocationCost(contentType.length) > 64 * 1024
    )
      return {
        state: "unavailable",
        reason: "body-read-failed",
        message: "Content type exceeds the retained metadata budget.",
      };
    return {
      state: "captured",
      representation:
        phase === "request"
          ? "browser-exposed-request-bytes"
          : "playwright-response-body-bytes",
      encoding: "base64",
      content: retained.toString("base64"),
      bytes: retained.length,
      sha256: createHash("sha256").update(retained).digest("hex"),
      media_type:
        contentType === undefined
          ? null
          : secrets.redactBytes(Buffer.from(contentType)).toString("utf8"),
      redacted: !retained.equals(observed),
    };
  } catch (cause: unknown) {
    return {
      state: "unavailable",
      reason:
        cause instanceof AnalysisCancelledError
          ? "cancelled"
          : cause instanceof AnalysisTimeoutError
            ? "body-read-timeout"
            : "body-read-failed",
      message: errorMessage(cause, secrets),
    };
  }
};
