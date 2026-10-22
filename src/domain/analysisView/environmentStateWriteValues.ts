import { createHash } from "node:crypto";
import type { JsonValue } from "../jsonValue.js";

/** How a recorded clock value is spelled: ISO-8601 with its separator, fraction digits and zone, or an epoch number. */
export type ClockFormat =
  | {
      readonly kind: "iso";
      readonly separator: "T" | " ";
      readonly fraction: number;
      readonly zone: string;
    }
  | { readonly kind: "epoch"; readonly unit: "s" | "ms" };

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/u;
const MINUTE_MS = 60_000;

/** Minutes east of UTC that a zone suffix names; none and `Z` are UTC. */
const zoneMinutes = (zone: string): number => {
  if (zone === "" || zone === "Z") return 0;
  const digits = zone.slice(1).replace(":", "");
  const minutes =
    Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0");
  return zone.startsWith("-") ? -minutes : minutes;
};

/** The instant of an ISO-8601 date-time and how it is spelled, or undefined when it is not one. */
const readIsoClock = (
  value: string,
): { readonly ms: number; readonly format: ClockFormat } | undefined => {
  const match = ISO_INSTANT.exec(value);
  if (match === null) return undefined;
  const [year, month, day, separator, hour, minute, second] = match
    .slice(1, 8)
    .map((part) => (part === "T" || part === " " ? part : Number(part)));
  const fraction = match[8] ?? "";
  const zone = match[9] ?? "";
  const local = Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    minute as number,
    second as number,
    Number(`${fraction}000`.slice(0, 3)),
  );
  // Date.UTC rolls invalid fields over; the round trip refuses them.
  const rolled = new Date(local);
  if (
    rolled.getUTCFullYear() !== year ||
    rolled.getUTCMonth() !== (month as number) - 1 ||
    rolled.getUTCDate() !== day ||
    rolled.getUTCHours() !== hour ||
    rolled.getUTCMinutes() !== minute
  )
    return undefined;
  return {
    ms: local - zoneMinutes(zone) * MINUTE_MS,
    format: {
      kind: "iso",
      separator: separator as "T" | " ",
      fraction: fraction.length,
      zone,
    },
  };
};

/** The instant a clock value names and its format: an ISO-8601 date-time, or epoch seconds or milliseconds. */
export const readClock = (
  value: JsonValue | undefined,
): { readonly ms: number; readonly format: ClockFormat } | undefined => {
  if (typeof value === "string") return readIsoClock(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return undefined;
  if (value >= 1e9 && value < 1e10)
    return { ms: value * 1000, format: { kind: "epoch", unit: "s" } };
  if (value >= 1e12 && value < 1e13)
    return { ms: value, format: { kind: "epoch", unit: "ms" } };
  return undefined;
};

const pad = (value: number, width: number): string =>
  String(value).padStart(width, "0");

/** An instant spelled in a recorded clock format; fraction digits past milliseconds are zeros. */
export const formatClock = (ms: number, format: ClockFormat): JsonValue => {
  if (format.kind === "epoch")
    return format.unit === "s" ? Math.floor(ms / 1000) : ms;
  const at = new Date(ms + zoneMinutes(format.zone) * MINUTE_MS);
  const fraction =
    format.fraction === 0
      ? ""
      : `.${`${pad(at.getUTCMilliseconds(), 3)}${"0".repeat(9)}`.slice(0, format.fraction)}`;
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1, 2)}-${pad(at.getUTCDate(), 2)}${format.separator}${pad(at.getUTCHours(), 2)}:${pad(at.getUTCMinutes(), 2)}:${pad(at.getUTCSeconds(), 2)}${fraction}${format.zone}`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const isUuid = (value: JsonValue | undefined): value is string =>
  typeof value === "string" && UUID.test(value);

/** An integer value as a number, from a JSON number or a string of digits. */
export const integerOf = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : typeof value === "string" && /^\d{1,15}$/u.test(value)
      ? Number(value)
      : undefined;

/**
 * The next value of a sequence. With nothing taken yet, that is the next held integer, or 1 when
 * the scope holds none. Otherwise it is one past the later of that and the last value taken.
 * A missing side leaves a negative value negative.
 */
export const nextSequence = (
  held: number | undefined,
  taken: number | undefined,
): number =>
  taken === undefined ? (held ?? 1) : Math.max(held ?? taken + 1, taken + 1);

/** An integer spelled as the recorded value spells integers: a number, or a string of digits. */
export const spelledLike = (exemplar: JsonValue, value: number): JsonValue =>
  typeof exemplar === "string" ? String(value) : value;

/** Lower case, with every run of other characters joined by one `-` and none at either end. */
export const slugOf = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const isAlphanumeric = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}]/u.test(character);

/** Start offsets of `token` in `text` where neither neighbour is a letter or digit. */
export const delimitedOffsets = (text: string, token: string): number[] => {
  const offsets: number[] = [];
  if (token.length === 0) return offsets;
  let at = text.indexOf(token);
  while (at >= 0) {
    const delimited =
      !isAlphanumeric(text[at - 1]) && !isAlphanumeric(text[at + token.length]);
    if (delimited) offsets.push(at);
    // A rejected match may overlap a delimited one, so the search moves on by one character.
    at = text.indexOf(token, at + (delimited ? token.length : 1));
  }
  return offsets;
};

/** `text` with every delimited occurrence of `token` replaced. */
export const replaceDelimited = (
  text: string,
  token: string,
  replacement: string,
): string => {
  let result = "";
  let from = 0;
  for (const at of delimitedOffsets(text, token)) {
    result += text.slice(from, at) + replacement;
    from = at + token.length;
  }
  return result + text.slice(from);
};

/** Whether any string inside a value holds `token` delimited. */
export const containsDelimited = (value: JsonValue, token: string): boolean => {
  const pending: JsonValue[] = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next === "string") {
      if (delimitedOffsets(next, token).length > 0) return true;
    } else if (typeof next === "object" && next !== null)
      // One at a time: spreading a wide array into push overflows the call stack.
      for (const child of Array.isArray(next) ? next : Object.values(next))
        pending.push(child);
  }
  return false;
};

/** SHA-256 bytes of a seed, extended by counter blocks to the requested length. */
const seededBytes = (seed: string, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let block = 0; block * 32 < length; block += 1) {
    const digest = createHash("sha256")
      .update(`${seed}#${String(block)}`)
      .digest();
    bytes.set(
      digest.subarray(0, Math.min(32, length - block * 32)),
      block * 32,
    );
  }
  return bytes;
};

/** A version 4 UUID derived from a seed, in the recorded value's letter case. */
export const seededUuid = (seed: string, exemplar: string): string => {
  const bytes = seededBytes(seed, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return exemplar === exemplar.toUpperCase() && /[A-F]/u.test(exemplar)
    ? uuid.toUpperCase()
    : uuid;
};

const DIGITS = "0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();

/** The characters a token of this spelling draws from: hexadecimal, or the digit and letter cases it uses. */
const tokenAlphabet = (exemplar: string): string => {
  if (/^[0-9a-f]+$/u.test(exemplar) && /[0-9]/u.test(exemplar))
    return `${DIGITS}abcdef`;
  if (/^[0-9A-F]+$/u.test(exemplar) && /[0-9]/u.test(exemplar))
    return `${DIGITS}ABCDEF`;
  const alphabet =
    (/[0-9]/u.test(exemplar) ? DIGITS : "") +
    (/[a-z]/u.test(exemplar) ? LOWER : "") +
    (/[A-Z]/u.test(exemplar) ? UPPER : "");
  return alphabet === "" ? LOWER : alphabet;
};

/** A token as long as the recorded one, from its alphabet, keeping its other characters in place. */
export const seededToken = (seed: string, exemplar: string): string => {
  const alphabet = tokenAlphabet(exemplar);
  const bytes = seededBytes(seed, exemplar.length);
  return [...exemplar]
    .map((character, index) =>
      /[0-9A-Za-z]/u.test(character)
        ? alphabet[bytes[index]! % alphabet.length]!
        : character,
    )
    .join("");
};
