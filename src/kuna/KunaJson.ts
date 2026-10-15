/** Parse numeric u64 addresses from their exact JSON tokens, before rounding. */
export const parseKunaJson = (
  text: string,
  limit: number,
  addressKeys: ReadonlySet<string>,
): unknown => {
  if (Buffer.byteLength(text) > limit)
    throw new Error("Kuna JSON exceeds its buffered capacity");
  return JSON.parse(
    text,
    (
      key: string,
      value: unknown,
      context?: { readonly source?: string },
    ): unknown => {
      if (!addressKeys.has(key) || value === null) return value;
      const source = context?.source;
      if (
        typeof value !== "number" ||
        source === undefined ||
        source.length > 20 ||
        !/^(?:0|[1-9][0-9]*)$/u.test(source)
      )
        throw new Error(`invalid numeric address in ${key}`);
      const exact = BigInt(source);
      if (exact > 0xffffffffffffffffn)
        throw new Error(`address in ${key} exceeds u64`);
      return `0x${exact.toString(16)}`;
    },
  );
};
