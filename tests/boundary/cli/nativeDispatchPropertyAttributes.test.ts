import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/** arm64 Mach-O whose two class properties share one attribute string. */
const machoWithPropertyAttributes = (attributes: string): Buffer => {
  const bytes = Buffer.alloc(4096);
  const base = 0x100000000n;
  const u32 = (at: number, value: number) => bytes.writeUInt32LE(value, at);
  const pointer = (at: number, offset: number) =>
    bytes.writeBigUInt64LE(base + BigInt(offset), at);
  u32(0, 0xfeedfacf);
  u32(4, 0x0100000c);
  u32(12, 2);
  u32(16, 1);
  u32(20, 152);
  u32(32, 0x19);
  u32(36, 152);
  bytes.write("__DATA", 40);
  pointer(56, 0);
  bytes.writeBigUInt64LE(4096n, 64);
  bytes.writeBigUInt64LE(4096n, 80);
  u32(88, 5);
  u32(92, 5);
  u32(96, 1);
  bytes.write("__objc_classlist", 104);
  bytes.write("__DATA", 120);
  pointer(136, 0x180);
  bytes.writeBigUInt64LE(8n, 144);
  u32(152, 0x180);
  pointer(0x180, 0x200);
  pointer(0x200 + 32, 0x300);
  u32(0x300, 2);
  u32(0x308, 16);
  pointer(0x300 + 24, 0x400);
  bytes.write("Fixture\0", 0x400);
  pointer(0x340, 0x500);
  u32(0x500, 16);
  u32(0x504, 2);
  pointer(0x508, 0x600);
  pointer(0x510, 0x620);
  pointer(0x518, 0x640);
  pointer(0x520, 0x620);
  bytes.write("first\0", 0x600);
  bytes.write(`${attributes}\0`, 0x620);
  bytes.write("second\0", 0x640);
  return bytes;
};

describe.skipIf(process.platform !== "darwin")(
  "native dispatch property attributes",
  () => {
    cliTest.for([
      ["complete nonatomic", "Tq,N", "nonatomic", false, "complete"],
      ["complete default", 'T@"NSString",C', "atomic", false, "complete"],
      ["unfinished quote", 'T@"NSString', null, null, "partial"],
      ["unfinished quote after R", 'R,T@"NSString', null, true, "partial"],
    ] as const)(
      "reports established property flags only for $0 attributes",
      async ([, attributes, atomicity, readonly, facet], { cli }) => {
        const directory = await createTestTempDirectory("rea-objc-property-");
        const path = join(directory, "fixture.bin");
        await writeFile(path, machoWithPropertyAttributes(attributes));
        const output = await cli.run({
          arguments: ["inspect-native-dispatch-metadata", path, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(output.exitCode).toBe(0);
        const property = {
          atomicity,
          is_readonly: readonly,
          attributes: expect.arrayContaining([
            { name: "T", value: expect.any(String) },
          ]),
        };
        expect(output.json).toMatchObject({
          normalized_result: {
            result: {
              objc_classes: [
                {
                  name: "Fixture",
                  properties: [
                    { name: "first", ...property },
                    { name: "second", ...property },
                  ],
                },
              ],
              coverage: expect.arrayContaining([
                expect.objectContaining({
                  facet: "objc_properties_categories",
                  status: facet,
                  reason:
                    facet === "partial"
                      ? expect.stringContaining(
                          "property_attributes_incomplete",
                        )
                      : null,
                }),
              ]),
            },
          },
        });
      },
    );
  },
);
