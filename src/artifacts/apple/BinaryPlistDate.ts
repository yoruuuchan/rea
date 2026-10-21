/**
 * Milliseconds between 1970-01-01 and 2001-01-01.
 * Matches plist@5 `parse-binary.js` `EPOCH_2001`.
 */
const APPLE_REFERENCE_EPOCH_MILLISECONDS = 978_307_200_000;

/**
 * Whether plist@5's `new Date(seconds * 1000 + epoch)` denotes the same
 * float64 seconds. Each source payload is judged on its own; distinct
 * instants can share one rounded millisecond.
 */
export const binaryPlistDateRepresentable = (seconds: number): boolean => {
  if (!Number.isFinite(seconds)) return false;
  const decoded = new Date(seconds * 1000 + APPLE_REFERENCE_EPOCH_MILLISECONDS);
  const time = Date.prototype.getTime.call(decoded);
  if (!Number.isFinite(time)) return false;
  return (time - APPLE_REFERENCE_EPOCH_MILLISECONDS) / 1000 === seconds;
};
