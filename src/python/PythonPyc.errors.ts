/** Distinguish corrupt recognized pycs from magics outside parser coverage. */
export class PythonPycFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "PythonPycFormatFailure";
  }
}

/** Resource boundary exceeded while walking marshal objects. */
export class PythonPycResourceFailure extends Error {
  constructor(
    readonly boundary: "objects" | "depth" | "string",
    readonly reported_limits: Readonly<Record<string, number>>,
    message: string,
  ) {
    super(message);
    this.name = "PythonPycResourceFailure";
  }
}
