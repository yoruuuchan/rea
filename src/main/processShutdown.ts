type ShutdownSignal = "SIGINT" | "SIGTERM";

interface ShutdownSignalSource {
  on(event: ShutdownSignal, listener: () => void): unknown;
  off(event: ShutdownSignal, listener: () => void): unknown;
}

interface ShutdownInputSource {
  once(event: "end" | "close", listener: () => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
}

interface ProcessShutdownEvents {
  readonly signals: ShutdownSignalSource;
  readonly stdin: ShutdownInputSource;
}

const processShutdownEvents: ProcessShutdownEvents = {
  signals: process,
  stdin: process.stdin,
};

/** Register the process events that request shutdown and return their owner. */
export const registerProcessShutdown = (
  handler: () => void,
  events: ProcessShutdownEvents = processShutdownEvents,
): (() => void) => {
  events.signals.on("SIGINT", handler);
  events.signals.on("SIGTERM", handler);
  events.stdin.once("end", handler);
  events.stdin.once("close", handler);
  return () => {
    events.signals.off("SIGINT", handler);
    events.signals.off("SIGTERM", handler);
    events.stdin.off("end", handler);
    events.stdin.off("close", handler);
  };
};
