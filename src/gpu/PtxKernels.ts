import { BinaryFormatFailure } from "../native/metadata/BinaryContainer.js";
import type { GpuKernel } from "../domain/gpu/gpuCodeObjects.js";
import { BinaryResourceFailure } from "../native/metadata/BinaryContainer.js";
import { GPU_REPORT_BYTES, rejectGpu } from "./GpuSource.js";
interface Token {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}
/** Byte coordinates are accumulated once, including non-ASCII comments and quoted strings. */
function* tokens(text: string): Generator<Token> {
  let at = 0,
    byte = 0;
  const advance = (): void => {
    const code = text.codePointAt(at)!;
    at += code > 0xffff ? 2 : 1;
    byte += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  };
  while (at < text.length) {
    if (/\s/u.test(text[at]!)) {
      advance();
      continue;
    }
    if (text.startsWith("//", at)) {
      while (at < text.length && text[at] !== "\n") advance();
      continue;
    }
    if (text.startsWith("/*", at)) {
      advance();
      advance();
      while (at < text.length && !text.startsWith("*/", at)) advance();
      if (at === text.length) rejectGpu("Unterminated PTX comment");
      advance();
      advance();
      continue;
    }
    const start = byte,
      position = at;
    if (text[at] === '"') {
      advance();
      let closed = false;
      while (at < text.length) {
        if (text[at] === '"') {
          advance();
          closed = true;
          break;
        }
        if (text[at] === "\\") {
          advance();
          if (at < text.length) advance();
        } else advance();
      }
      if (!closed) rejectGpu("Unterminated PTX string");
      yield { value: '""', start, end: byte };
      continue;
    }
    if (/[.\w$%@]/u.test(text[at]!)) {
      while (at < text.length && /[.\w$%@]/u.test(text[at]!)) advance();
    } else advance();
    if (at - position > 65536)
      throw new BinaryResourceFailure(
        "structure",
        65536,
        "PTX token exceeds the string budget",
      );
    yield { value: text.slice(position, at), start, end: byte };
  }
}
const integer = (token: string | undefined): number | null => {
  if (token === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
};
const sizeOf = (type: string | undefined): number | null => {
  const match = /^\.(?:b|u|s|f)(8|16|32|64|128)$/u.exec(type ?? "");
  return match === null ? null : Number(match[1]) / 8;
};
/** Parse every declared register name/range; unsupported forms poison the type total. */
const registerDeclaration = (
  values: string[],
): { type: string; count: number | null } => {
  const identifier = /^%?[A-Za-z_$][\w$@.]*$/u;
  const firstName = values.findIndex((value) => identifier.test(value));
  if (firstName <= 0)
    return rejectGpu("PTX register declaration has no type or name");
  const type = values.slice(0, firstName).join(" ");
  if (firstName !== 1 || !/^\.(?:pred|[busf](?:8|16|32|64|128))$/u.test(type))
    return { type, count: null };
  let at = firstName,
    count = 0;
  while (at < values.length) {
    if (!identifier.test(values[at++]!)) return { type, count: null };
    let declared = 1;
    if (values[at] === "<") {
      const range = integer(values[at + 1]);
      if (range === null || range === 0 || values[at + 2] !== ">")
        return { type, count: null };
      declared = range;
      at += 3;
    }
    if (!Number.isSafeInteger(count + declared)) return { type, count: null };
    count += declared;
    if (at === values.length) return { type, count };
    if (values[at++] !== "," || at === values.length)
      return { type, count: null };
  }
  return { type, count: null };
};
const declaration = (
  source: string[],
): {
  name: string | null;
  type: string | null;
  size: number | null;
  align: number | null;
} => {
  const values = source[0] === ".param" ? source.slice(1) : source;
  let at = 0;
  const explicit = values[at] === ".align";
  const alignment = explicit ? integer(values[++at]) : null;
  if (explicit) at++;
  const vector = values[at] === ".v2" ? 2 : values[at] === ".v4" ? 4 : 1;
  if (vector !== 1) at++;
  const scalar = values[at++],
    unit = sizeOf(scalar),
    candidate = values[at++];
  const name =
    candidate !== undefined && /^[A-Za-z_$][\w$@.]*$/u.test(candidate)
      ? candidate
      : null;
  let size = unit === null ? null : unit * vector;
  const type =
    scalar === undefined
      ? null
      : vector === 1
        ? scalar
        : `.v${vector} ${scalar}`;
  const align = explicit ? alignment : size;
  if (values[at] === "[") {
    const count = integer(values[at + 1]);
    size =
      count === null ||
      size === null ||
      values[at + 2] !== "]" ||
      !Number.isSafeInteger(count * size)
        ? null
        : count * size;
    at += 3;
  }
  if (
    at !== values.length ||
    name === null ||
    align === null ||
    align <= 0 ||
    !Number.isInteger(Math.log2(align))
  )
    return { name, type, size: null, align: null };
  return { name, type, size, align };
};

/** Entry declarations and virtual resources; no instruction semantics or physical register claims. */
export function* readPtxKernels(
  text: string,
  objectId: string,
): Generator<{ kernel: GpuKernel; coverage: "complete" | "partial" }> {
  if (Buffer.byteLength(text) > GPU_REPORT_BYTES)
    throw new BinaryResourceFailure(
      "structure",
      GPU_REPORT_BYTES,
      "PTX text exceeds the 16 MiB retained report budget",
    );
  const iterator = tokens(text);
  const next = (): Token => {
    const value = iterator.next();
    if (value.done) return rejectGpu("Truncated PTX entry declaration");
    return value.value;
  };
  let kernelCount = 0;
  let outerDepth = 0;
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    const token = step.value;
    if (token.value === "{") {
      outerDepth++;
      continue;
    }
    if (token.value === "}") {
      if (outerDepth === 0) rejectGpu("Unbalanced PTX body");
      outerDepth--;
      continue;
    }
    if (outerDepth !== 0 || token.value !== ".entry") continue;
    const name = next();
    if (!/^[A-Za-z_$][\w$@.]*$/u.test(name.value) || next().value !== "(")
      rejectGpu("Malformed PTX entry name or parameters");
    const parameters: GpuKernel["parameters"] = [];
    let part: string[] = [],
      parameterBytes: number | null = 0;
    const flush = (): void => {
      if (part.length === 0) return;
      if (part[0] !== ".param") rejectGpu("Unknown PTX parameter declaration");
      const value = declaration(part);
      let offset: number | null = null;
      if (
        parameterBytes !== null &&
        value.size !== null &&
        value.align !== null &&
        value.align > 0 &&
        Number.isSafeInteger(value.align)
      ) {
        offset = Math.ceil(parameterBytes / value.align) * value.align;
        parameterBytes = Number.isSafeInteger(offset + value.size)
          ? offset + value.size
          : null;
      } else parameterBytes = null;
      parameters.push({
        ordinal: parameters.length,
        name: value.name,
        offset,
        size: value.size,
        type: value.type,
        hidden: null,
      });
      part = [];
    };
    for (let t = next(); t.value !== ")"; t = next()) {
      if (t.value === ",") flush();
      else part.push(t.value);
      if (part.length > 128 || parameters.length > 65536)
        throw new BinaryResourceFailure(
          "structure",
          65536,
          "PTX parameter declarations exceed the facts budget",
        );
    }
    flush();
    let t = next();
    // Entry directives can occur between the parameter list and body.
    let headerTokens = 0;
    while (t.value !== "{" && t.value !== ";") {
      if (++headerTokens > 65536) rejectGpu("PTX entry header is too large");
      t = next();
    }
    let end = t.end,
      shared: number | null = t.value === "{" ? 0 : null;
    const virtual = new Map<string, number | null>();
    if (t.value === "{") {
      let depth = 1;
      while (depth > 0) {
        t = next();
        end = t.end;
        if (t.value === "{") {
          depth++;
          continue;
        }
        if (t.value === "}") {
          depth--;
          continue;
        }
        if (t.value !== ".reg" && t.value !== ".shared") continue;
        const kind = t.value;
        const declarationTokens: string[] = [];
        for (t = next(); t.value !== ";"; t = next()) {
          if (t.value === "}" || declarationTokens.length > 128)
            rejectGpu("Malformed PTX resource declaration");
          declarationTokens.push(t.value);
        }
        if (kind === ".reg") {
          const { type, count } = registerDeclaration(declarationTokens);
          const previous = virtual.get(type);
          const total =
            previous === null || count === null
              ? null
              : (previous ?? 0) + count;
          virtual.set(
            type,
            total === null || !Number.isSafeInteger(total) ? null : total,
          );
        } else {
          const value = declaration(declarationTokens);
          if (
            shared === null ||
            value.size === null ||
            value.align === null ||
            value.align === 0
          )
            shared = null;
          else {
            const total =
              Math.ceil(shared / value.align) * value.align + value.size;
            shared = Number.isSafeInteger(total) ? total : null;
          }
        }
      }
    }
    const kernel: GpuKernel = {
      id: `${objectId}/entry@${token.start.toString(16)}`,
      object_id: objectId,
      representation: "ptx-declarations",
      name: name.value,
      symbol: null,
      parameter_count: parameters.length,
      parameter_bytes: parameterBytes,
      parameters,
      registers: {
        physical: null,
        sgpr: null,
        vgpr: null,
        agpr: null,
        virtual: [...virtual].map(([type, count]) => ({ type, count })),
      },
      shared_bytes: shared,
      private_bytes: null,
      location: {
        container_id: objectId,
        offset: token.start,
        size: end - token.start,
        section_index: null,
        section_name: null,
      },
      sources: {
        parameters: {
          container_id: objectId,
          offset: token.start,
          size: end - token.start,
          section_index: null,
          section_name: null,
        },
        registers: null,
        shared: null,
        private: null,
      },
      limitations: [
        "PTX registers are virtual declarations, not physical allocations. Parameter offsets/sizes and entry-local static shared bytes are derived from supported declarations; module shared bytes, dynamic allocation, device ABI and runtime allocation were not verified.",
      ],
    };
    let coverage: "complete" | "partial" = "complete";
    if (parameterBytes === null) {
      coverage = "partial";
      kernel.limitations.push(
        "Unsupported PTX parameter declarations or overflowing layouts leave parameter sizes/offsets and the total byte count unknown.",
      );
    }
    if (shared === null) {
      coverage = "partial";
      kernel.limitations.push(
        "Unsupported, dynamic or overflowing PTX shared declarations, or an absent entry body, leave entry-local static shared bytes unknown.",
      );
    }
    if (kernel.registers.virtual.some((row) => row.count === null)) {
      coverage = "partial";
      kernel.limitations.push(
        "Unsupported PTX register declarations or overflowing totals leave the affected virtual register count unknown.",
      );
    }
    if (++kernelCount > 65536)
      throw new BinaryResourceFailure(
        "structure",
        65536,
        "PTX kernel count exceeds the facts budget",
      );
    yield { kernel, coverage };
  }
  if (outerDepth !== 0) rejectGpu("Unbalanced PTX body");
}

/** Positive PTX header recognition uses the same lexer as kernel extraction. */
export const readPtxTarget = (text: string): string | null => {
  const stream = tokens(text);
  let version = false,
    target: string | null = null;
  try {
    for (const token of stream) {
      if (
        token.value === ".entry" ||
        token.value === ".func" ||
        token.value === "{"
      )
        break;
      if (token.value === ".version") {
        const value = stream.next();
        version = !value.done && /^[0-9]+\.[0-9]+$/u.test(value.value.value);
      }
      if (token.value === ".target") {
        const value = stream.next();
        target =
          !value.done && /^sm_[0-9]+[a-z]?$/u.test(value.value.value)
            ? value.value.value
            : null;
      }
      if (version && target !== null) return target;
    }
  } catch (cause) {
    if (!(cause instanceof BinaryFormatFailure)) throw cause;
    // A malformed quote/comment before both directives does not establish PTX identity.
  }
  return null;
};
