import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../../src/domain/analysisErrorCore.js";
import { Il2cppMetadataProvider } from "../../../src/il2cpp/Il2cppMetadataProvider.js";
import { createIl2cppMetadataFixture } from "../../fixtures/il2cpp/metadata.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Version 29 file whose methods all share one long name. */
const sharedNameMetadata = (
  nameBytes: number | Buffer,
  methods: number,
  fill = 0x41,
) => {
  const encoded = Buffer.isBuffer(nameBytes)
    ? nameBytes
    : Buffer.alloc(nameBytes, fill);
  const name = Buffer.concat([encoded, Buffer.from([0])]);
  const records = Buffer.alloc(methods * 32);
  for (let index = 0; index < methods; index += 1)
    records.writeInt32LE(-1, index * 32 + 4);
  const header = Buffer.alloc(256);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeInt32LE(29, 4);
  let cursor = 256;
  for (let section = 0; section < 31; section += 1) {
    // strings is section 2 and methods is section 5.
    const content = section === 2 ? name : section === 5 ? records : undefined;
    header.writeInt32LE(cursor, 8 + section * 8);
    header.writeInt32LE(content?.length ?? 0, 12 + section * 8);
    cursor += content?.length ?? 0;
  }
  return Buffer.concat([header, name, records]);
};

it("refuses an oversized report from its row lower bound before serializing it", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-budget-");
  const path = join(root, "global-metadata.dat");
  // Shared names make about 100 KiB of input expand beyond 64 MiB of JSON.
  await writeFile(path, sharedNameMetadata(65_536, 1_100));
  const stringify = vi.spyOn(JSON, "stringify");
  const provider = new Il2cppMetadataProvider();
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) =>
          typeof value === "object" && value !== null && "methods" in value,
      ),
    ).toBe(false);
  } finally {
    await provider.close();
  }
});

it("counts escaped name characters toward the budget without escaping the name", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-escape-");
  const path = join(root, "global-metadata.dat");
  // 4 KiB of U+0001 is 4 KiB raw but 24 KiB once escaped as .
  await writeFile(path, sharedNameMetadata(4096, 1, 0x01));
  const stringify = vi.spyOn(JSON, "stringify");
  const provider = new Il2cppMetadataProvider(8192);
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) => typeof value === "string" && value.length >= 4096,
      ),
    ).toBe(false);
  } finally {
    await provider.close();
  }
});

it("admits a report whose escaped names fit the budget exactly", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-fit-");
  const path = join(root, "global-metadata.dat");
  await writeFile(path, sharedNameMetadata(4096, 1, 0x01));
  const unbounded = new Il2cppMetadataProvider();
  let bytes: number;
  try {
    const result = await unbounded.inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.methods[0]?.name).toBe("".repeat(4096));
    bytes = Buffer.byteLength(JSON.stringify(result.value));
  } finally {
    await unbounded.close();
  }
  const exact = new Il2cppMetadataProvider(bytes);
  try {
    expect((await exact.inspect({ path })).ok).toBe(true);
  } finally {
    await exact.close();
  }
});

it("refuses from row counts before decoding any row", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-counts-");
  const path = join(root, "global-metadata.dat");
  // A broken method name would fail as invalid-string if rows were decoded.
  const fixture = createIl2cppMetadataFixture();
  const bytes = Buffer.from(fixture.bytes);
  bytes.writeInt32LE(0x7fff, fixture.record("methods", 0));
  await writeFile(path, bytes);
  const provider = new Il2cppMetadataProvider(256);
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  } finally {
    await provider.close();
  }
});

it.each([
  { requested: "cancel during metadata decoding" },
  new AnalysisResourceConstraintError(
    "caller-selected-reason",
    "memory",
    "Caller cancellation reason",
    {},
  ),
])(
  "accepts cancellation during decoded batches with exact reason %j",
  async (reason) => {
    const root = await createTestTempDirectory("rea-il2cpp-provider-cancel-");
    const path = join(root, "global-metadata.dat");
    const bytes = sharedNameMetadata(1, 100_000);
    await writeFile(path, bytes);
    const controller = new AbortController();
    let batches = 0;
    const provider = new Il2cppMetadataProvider(undefined, async () => {
      await setImmediate();
      if (++batches === 3) controller.abort(reason);
    });
    try {
      const result = await provider.inspect(
        { path },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
      expect(batches).toBe(3);
      expect(result.error.partialObservation).toMatchObject({
        operation: "observe_il2cpp_metadata_source",
        normalized_result: {
          artifact: {
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          },
          inventory_status: "not-returned-as-complete",
          validated_section_row_counts: {
            images: 0,
            types: 0,
            methods: 100_000,
          },
        },
      });
      const replacement = createIl2cppMetadataFixture();
      await writeFile(path, replacement.bytes);
      const next = await provider.inspect({ path });
      if (!next.ok) throw next.error;
      expect(next.value.artifact.sha256).toBe(
        createHash("sha256").update(replacement.bytes).digest("hex"),
      );
      expect(next.value.methods).toHaveLength(5);
    } finally {
      await provider.close();
    }
  },
);

it("bounds concurrent snapshots and retains active decoding until close completes", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-close-");
  const path = join(root, "global-metadata.dat");
  await writeFile(path, createIl2cppMetadataFixture().bytes);
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let resume!: () => void;
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const provider = new Il2cppMetadataProvider(undefined, () => {
    markEntered();
    return release;
  });
  const active = provider.inspect({ path });
  await entered;
  let closed = false;
  const closing = provider.close().then(() => {
    closed = true;
  });
  try {
    const refused = await provider.inspect({ path });
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);
    await setImmediate();
    expect(closed).toBe(false);
  } finally {
    resume();
    await closing;
  }
  expect((await active).ok).toBe(true);
  expect(closed).toBe(true);
  expect((await provider.inspect({ path })).ok).toBe(false);
});

it("refuses UTF-8 expansion before serializing the complete report", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-unicode-");
  const path = join(root, "global-metadata.dat");
  await writeFile(path, sharedNameMetadata(Buffer.from("雪".repeat(4096)), 1));
  const stringify = vi.spyOn(JSON, "stringify");
  const provider = new Il2cppMetadataProvider(8192);
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) =>
          typeof value === "object" && value !== null && "methods" in value,
      ),
    ).toBe(false);
  } finally {
    await provider.close();
  }
});

it.each([false, true])(
  "keeps an independent failure with shared cancellation reason: %s",
  async (sharedReason) => {
    const root = await createTestTempDirectory("rea-il2cpp-failure-cancel-");
    const path = join(root, "global-metadata.dat");
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    const controller = new AbortController();
    const failure = Object.assign(
      new Error("independent scheduler I/O failure"),
      { code: "EIO" },
    );
    const provider = new Il2cppMetadataProvider(undefined, () => {
      controller.abort(sharedReason ? failure : "separate caller cancellation");
      return Promise.reject(failure);
    });
    try {
      const result = await provider.inspect(
        { path },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected the independent failure");
      expect(result.error).not.toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(failure);
    } finally {
      await provider.close();
    }
  },
);

it("retains the exact empty source observation without claiming a decoded inventory", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-empty-");
  const path = join(root, "empty.dat");
  await writeFile(path, Buffer.alloc(0));
  const provider = new Il2cppMetadataProvider();
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected unsupported empty metadata");
    expect(result.error.message).toContain("unrecognized-magic");
    expect(result.error.partialObservation).toMatchObject({
      operation: "observe_il2cpp_metadata_source",
      normalized_result: {
        artifact: {
          path,
          bytes: 0,
          sha256: createHash("sha256").digest("hex"),
        },
        inventory_status: "not-returned-as-complete",
      },
    });
  } finally {
    await provider.close();
  }
});
