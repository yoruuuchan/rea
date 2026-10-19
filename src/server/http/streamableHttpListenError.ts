/** The listener could not bind before any client connected; the message names the system cause. */
export class StreamableHttpListenError extends Error {
  override readonly name = "StreamableHttpListenError";
  constructor(cause: unknown) {
    super(
      `MCP HTTP listener could not bind: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
