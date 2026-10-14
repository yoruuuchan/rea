import type {
  BrowserNetworkBody,
  BrowserNetworkContentSelection,
} from "../../domain/browserNetworkEvidence.js";
import type { BrowserScenarioEvent } from "../../domain/browserScenarioCaptureValues.js";
import type { BrowserScenarioSecrets } from "../BrowserScenarioSecrets.js";
import {
  captureNetworkBody,
  captureNetworkHeaders,
  type NetworkHeadersSource,
  type NetworkReadOptions,
} from "./PlaywrightNetworkContent.js";

/** Request object identity is the association key, never URL or receipt adjacency. */
export interface ScenarioNetworkRequest extends NetworkHeadersSource {
  method(): string;
  url(): string;
  resourceType(): string;
  postDataBuffer(): Buffer | null;
  redirectedFrom(): ScenarioNetworkRequest | null;
  failure(): { errorText: string } | null;
}

/** A response's body becomes eligible for reading only after requestfinished. */
export interface ScenarioNetworkResponse extends NetworkHeadersSource {
  request(): ScenarioNetworkRequest;
  url(): string;
  status(): number;
  body(): Promise<Buffer>;
}

type UnindexedNetworkEvent = BrowserScenarioEvent extends infer Event
  ? Event extends BrowserScenarioEvent
    ? Event["kind"] extends
        | "request"
        | "response"
        | "request-finished"
        | "request-failed"
        | "request-unfinished"
        | "network-content"
      ? Omit<Event, "sequence" | "step_index">
      : never
    : never
  : never;

interface Transaction {
  readonly id: string;
  readonly redirectedFrom: string | null;
  readonly redirectedFromState: "root" | "unknown" | undefined;
  response?: {
    readonly source: ScenarioNetworkResponse;
    readonly sequence: number;
  };
  terminal?: "finished" | "failed";
  responseScheduled: boolean;
  requestObserved: boolean;
}

interface NetworkCaptureOptions {
  readonly selection: BrowserNetworkContentSelection;
  readonly secrets: BrowserScenarioSecrets;
  readonly emit: (event: UnindexedNetworkEvent) => number;
  /** Check aggregate event capacity before redacting producer-owned metadata. */
  readonly admitText?: (values: Iterable<string>) => boolean;
  readonly signal?: AbortSignal;
  /** Production uses 5s; a fixture can supply its own bounded-read clock. */
  readonly readTimeoutMs?: number;
}

/** Captures correlated network phases and drains selected content before browser cleanup. */
export class PlaywrightScenarioNetwork {
  private readonly transactions = new Map<
    ScenarioNetworkRequest,
    Transaction
  >();
  private readonly pending: Promise<void>[] = [];
  private readonly gaps = new Set<string>();
  private accepting = true;
  private activeReads = 0;
  private readonly readOptions: NetworkReadOptions;

  constructor(private readonly options: NetworkCaptureOptions) {
    this.readOptions = {
      timeoutMs: options.readTimeoutMs ?? 5_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  /** Observe a request start, retaining the producer's redirect relationship when known. */
  request(request: ScenarioNetworkRequest): void {
    if (!this.accepting) return;
    const transaction = this.transaction(request);
    if (transaction === undefined || transaction.requestObserved) return;
    if (!this.admitMetadata(request)) return;
    transaction.requestObserved = true;
    const sequence = this.options.emit({
      ...this.metadata(request, transaction),
      kind: "request",
      status: null,
      failure: null,
    });
    if (sequence === 0) return;
    if (
      this.options.selection.request_body ||
      this.options.selection.header_values
    )
      this.collect(transaction, sequence, "request", request, () =>
        this.options.selection.request_body
          ? captureNetworkBody(
              async () => request.postDataBuffer(),
              "request",
              request,
              this.options.secrets,
              this.readOptions,
            )
          : Promise.resolve({ state: "not_requested" }),
      );
  }

  /** Observe response metadata without starting a potentially unfinished body read. */
  response(response: ScenarioNetworkResponse): void {
    if (!this.accepting) return;
    const request = response.request();
    const transaction = this.transaction(request);
    if (
      transaction === undefined ||
      !this.admitMetadata(
        request,
        undefined,
        [],
        [{ source: response, url: response.url() }],
      )
    )
      return;
    const sequence = this.options.emit({
      ...this.metadata(request, transaction),
      kind: "response",
      url: this.options.secrets.sanitizeUrl(response.url()),
      status: response.status(),
      header_names: this.headerNames(response),
      failure: null,
    });
    if (sequence === 0) return;
    transaction.response = { source: response, sequence };
  }

  /** Record completion and read selected content through the response API. */
  finished(request: ScenarioNetworkRequest): void {
    if (!this.accepting) return;
    const transaction = this.transaction(request);
    if (transaction === undefined || !this.admitMetadata(request)) return;
    transaction.terminal = "finished";
    const sequence = this.options.emit({
      ...this.metadata(request, transaction),
      kind: "request-finished",
      status: null,
      failure: null,
    });
    if (sequence === 0) {
      transaction.responseScheduled = true;
      return;
    }
    this.responseContent(transaction);
  }

  /** Preserve request failure separately from missing or unreadable response content. */
  failed(request: ScenarioNetworkRequest): void {
    if (!this.accepting) return;
    const transaction = this.transaction(request);
    if (transaction === undefined) return;
    transaction.terminal = "failed";
    const failure = request.failure()?.errorText || "Unknown request failure";
    if (!this.admitMetadata(request, undefined, [failure])) return;
    const message = this.options.secrets.redact(failure);
    const sequence = this.options.emit({
      ...this.metadata(request, transaction),
      kind: "request-failed",
      status: null,
      failure: message,
    });
    if (sequence === 0) {
      transaction.responseScheduled = true;
      return;
    }
    this.responseContent(transaction, {
      state: "unavailable",
      reason: "request-failed",
      message,
    });
  }

  /** Stop observing, mark unfinished transactions, and settle bounded content reads. */
  async finish(): Promise<void> {
    if (!this.accepting) {
      await Promise.all(this.pending);
      return;
    }
    this.accepting = false;
    for (const [request, transaction] of this.transactions) {
      if (transaction.terminal === undefined) {
        if (!this.admitMetadata(request)) continue;
        this.gaps.add(
          "Some network requests had not completed when capture ended; later activity is unknown.",
        );
        const sequence = this.options.emit({
          ...this.metadata(request, transaction),
          kind: "request-unfinished",
          status: null,
          failure: null,
          reason:
            this.options.signal?.aborted === true
              ? "cancelled"
              : "capture-ended",
        });
        if (sequence === 0) {
          transaction.responseScheduled = true;
          continue;
        }
        this.responseContent(transaction, {
          state: "unavailable",
          reason:
            this.options.signal?.aborted === true
              ? "cancelled"
              : "response-unfinished",
          message:
            "The response had not finished at the capture cutoff; no body read or refetch was attempted.",
        });
      }
    }
    await Promise.all(this.pending);
  }

  /** Missing selected content contributes to aggregate completeness. */
  limitations(): readonly string[] {
    return [...this.gaps];
  }

  private transaction(
    request: ScenarioNetworkRequest,
  ): Transaction | undefined {
    const known = this.transactions.get(request);
    if (known !== undefined) return known;
    if (this.transactions.size >= 1024) {
      this.gaps.add(
        "Network collection reached its 1024-transaction resource budget; further transactions were omitted.",
      );
      return undefined;
    }
    const predecessor = request.redirectedFrom();
    const predecessorTransaction =
      predecessor === null ? undefined : this.transactions.get(predecessor);
    const transaction: Transaction = {
      id: `request-${this.transactions.size + 1}`,
      redirectedFrom: predecessorTransaction?.id ?? null,
      redirectedFromState:
        predecessor === null
          ? "root"
          : predecessorTransaction === undefined
            ? "unknown"
            : undefined,
      responseScheduled: false,
      requestObserved: false,
    };
    this.transactions.set(request, transaction);
    return transaction;
  }

  private admitProducerStrings(values: Iterable<string>): boolean {
    const collected: string[] = [];
    let cost = 0;
    for (const value of values) {
      cost += this.options.secrets.redactionAllocationCost(value.length) + 128;
      if (cost > 1024 * 1024) {
        this.gaps.add(
          "Some network metadata exceeded its allocation budget and was omitted.",
        );
        return false;
      }
      collected.push(value);
    }
    if (this.options.admitText?.(collected) ?? true) return true;
    this.gaps.add(
      "Some network metadata was omitted because the aggregate browser event budget was reached; affected transactions are incomplete.",
    );
    return false;
  }

  private admitMetadata(
    source: NetworkHeadersSource,
    url?: string,
    additionalStrings: readonly string[] = [],
    additionalSources: readonly {
      source: NetworkHeadersSource;
      url?: string;
    }[] = [],
  ): boolean {
    return this.admitProducerStrings(
      this.metadataStrings(source, url, additionalStrings, additionalSources),
    );
  }

  private *metadataStrings(
    source: NetworkHeadersSource,
    url: string | undefined,
    additionalStrings: readonly string[],
    additionalSources: readonly {
      source: NetworkHeadersSource;
      url?: string;
    }[],
  ): Generator<string> {
    yield* this.retainedMetadataStrings(source, source.headers(), url);
    yield* additionalStrings;
    for (const extra of additionalSources)
      yield* this.retainedMetadataStrings(
        extra.source,
        extra.source.headers(),
        extra.url,
      );
  }

  private *retainedMetadataStrings(
    source: NetworkHeadersSource,
    headers: Readonly<Record<string, string>>,
    url?: string,
  ): Generator<string> {
    if (url !== undefined) yield url;
    for (const name in headers) {
      if (!Object.hasOwn(headers, name)) continue;
      yield name;
      // Names are always retained in metadata. Values are retained only in
      // selected header-value content; do not charge discarded values.
      if (this.options.selection.header_values) yield headers[name]!;
    }
    if ("method" in source) {
      const request = source as ScenarioNetworkRequest;
      yield request.method();
      yield request.url();
      yield request.resourceType();
    }
  }

  private headerNames(source: NetworkHeadersSource): string[] {
    return Object.keys(source.headers())
      .map((name) => this.options.secrets.redact(name))
      .sort();
  }

  private metadata(request: ScenarioNetworkRequest, transaction: Transaction) {
    return {
      transaction_id: transaction.id,
      redirected_from_transaction_id: transaction.redirectedFrom,
      ...(transaction.redirectedFromState === undefined
        ? {}
        : {
            redirected_from_transaction_state: transaction.redirectedFromState,
          }),
      method: this.options.secrets.redact(request.method()),
      url: this.options.secrets.sanitizeUrl(request.url()),
      resource_type: this.options.secrets.redact(request.resourceType()),
      header_names: this.headerNames(request),
    };
  }

  private responseContent(
    transaction: Transaction,
    unavailable?: BrowserNetworkBody,
  ): void {
    const response = transaction.response;
    if (
      response === undefined ||
      transaction.responseScheduled ||
      (!this.options.selection.response_body &&
        !this.options.selection.header_values)
    )
      return;
    transaction.responseScheduled = true;
    this.collect(
      transaction,
      response.sequence,
      "response",
      response.source,
      () =>
        this.options.selection.response_body
          ? unavailable === undefined
            ? captureNetworkBody(
                () => response.source.body(),
                "response",
                response.source,
                this.options.secrets,
                this.readOptions,
              )
            : Promise.resolve(unavailable)
          : Promise.resolve({ state: "not_requested" }),
    );
  }

  private collect(
    transaction: Transaction,
    sequence: number,
    phase: "request" | "response",
    source: NetworkHeadersSource,
    body: () => Promise<BrowserNetworkBody>,
  ): void {
    if (this.activeReads >= 16) {
      const message = "Network content exceeds the 16 concurrent-read budget.";
      this.gaps.add(message);
      this.options.emit({
        kind: "network-content",
        transaction_id: transaction.id,
        source_event_sequence: sequence,
        phase,
        headers: this.options.selection.header_values
          ? { state: "unavailable", message }
          : { state: "not_requested" },
        body: this.options.selection[
          phase === "request" ? "request_body" : "response_body"
        ]
          ? { state: "unavailable", reason: "body-read-failed", message }
          : { state: "not_requested" },
      });
      return;
    }
    this.activeReads += 1;
    const headers = this.options.selection.header_values
      ? captureNetworkHeaders(source, this.options.secrets, this.readOptions)
      : Promise.resolve({ state: "not_requested" } as const);
    this.pending.push(
      Promise.all([headers, body()])
        .then(([retainedHeaders, retainedBody]) => {
          if (
            retainedHeaders.state === "unavailable" ||
            retainedBody.state === "unavailable" ||
            retainedBody.state === "not_exposed"
          )
            this.gaps.add(
              "Some selected network content was unavailable; per-transaction content states retain the reason.",
            );
          this.options.emit({
            kind: "network-content",
            transaction_id: transaction.id,
            source_event_sequence: sequence,
            phase,
            headers: retainedHeaders,
            body: retainedBody,
          });
        })
        .finally(() => {
          this.activeReads -= 1;
        }),
    );
  }
}
