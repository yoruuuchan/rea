import { describe, expect, it } from "vitest";

import { buildManagedPeFixture } from "../../scripts/fixtures/managed/pe.mjs";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { managedPeFixtureTarget } from "./ManagedPe.fixture.js";

const rawOffset = (rva: number) => 0x200 + (rva - 0x2000);

describe("managed PE fixture layout", () => {
  it("preserves bodyless native methods without allocating an IL extent", () => {
    const image = buildManagedPeFixture({
      methods: [
        { name: "NativeMethod", flags: 0x2016, rva: 0 },
        { name: "ManagedMethod", body: Buffer.from([0x06, 0x2a]) },
      ],
    });
    const inspected = inspectManagedMembersBytes(
      image,
      managedPeFixtureTarget(image),
    );
    expect(inspected.methods[0]?.rva).toBe(0);
    expect(inspected.methods[0]?.body.status).toBe("absent");
    expect(inspected.methods[0]?.body.opcode_counts).toEqual({});
    expect(inspected.methods[1]?.body.opcode_counts).toEqual({ ret: 1 });
  });

  it("preserves complete adjacent method bodies", () => {
    const firstBody = Buffer.concat([
      Buffer.from([0x9e]),
      Buffer.alloc(38),
      Buffer.from([0x2a]),
    ]);
    const secondBody = Buffer.from([0x06, 0x2a]);
    const image = buildManagedPeFixture({
      methods: [
        { name: "LongBody", body: firstBody },
        { name: "NextBody", body: secondBody },
      ],
    });

    expect(
      image.subarray(rawOffset(0x2800), rawOffset(0x2800) + firstBody.length),
    ).toEqual(firstBody);
    expect(
      image.subarray(rawOffset(0x2840), rawOffset(0x2840) + secondBody.length),
    ).toEqual(secondBody);
    const inspected = inspectManagedMembersBytes(
      image,
      managedPeFixtureTarget(image),
    );
    expect(inspected.methods.map(({ body }) => body.opcode_counts)).toEqual([
      { nop: 38, ret: 1 },
      { ret: 1 },
    ]);
  });

  it("keeps the ReadyToRun signature outside expanded metadata", () => {
    const image = buildManagedPeFixture({
      readyToRun: true,
      methods: Array.from({ length: 47 }, (_, index) => ({
        name: `Method${index}`,
      })),
    });
    const nativeHeaderRva = image.readUInt32LE(0x240);
    const nativeHeaderSize = image.readUInt32LE(0x244);

    expect(nativeHeaderSize).toBe(4);
    expect(
      image
        .subarray(rawOffset(nativeHeaderRva), rawOffset(nativeHeaderRva) + 4)
        .toString("latin1"),
    ).toBe("RTR\0");
  });
});
