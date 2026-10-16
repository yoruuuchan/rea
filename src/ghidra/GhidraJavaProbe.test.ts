import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeGhidraJava } from "./GhidraJavaProbe.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
afterEach(() => vi.mocked(spawnSync).mockReset());

const probe = (values: Partial<ReturnType<typeof spawnSync>>) => {
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    status: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    output: [],
    ...values,
  } as never);
  return probeGhidraJava("/selected/bin/java", {});
};

describe("Ghidra Java prerequisite process facts", () => {
  it.each([
    ["ENOENT", "runtime_missing"],
    ["EACCES", "runtime_unavailable"],
    ["ETIMEDOUT", "runtime_unavailable"],
    ["ENOBUFS", "runtime_unavailable"],
  ])("keeps %s distinct from other runtime failures", (code, expected) => {
    const error = Object.assign(new Error(`controlled ${code}`), { code });
    expect(probe({ error, status: null })).toMatchObject({
      ok: false,
      error: {
        _tag: "GhidraJavaProbeFailure",
        code: expected,
        processErrorCode: code,
        detail: expect.stringContaining(code),
        output: { exit_code: null, truncated: code === "ENOBUFS" },
      },
    });
  });

  it("keeps raw byte counts and both streams on a nonzero exit", () => {
    const result = probe({
      status: 7,
      stdout: Buffer.from([0xff]),
      stderr: Buffer.from("controlled runtime failure\n"),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "runtime_unavailable",
        detail: expect.stringContaining("Java exited 7"),
        output: {
          stdout: "\ufffd",
          stdout_bytes: 1,
          stderr: "controlled runtime failure\n",
          stderr_bytes: 27,
          exit_code: 7,
          signal: null,
          truncated: false,
        },
      },
    });
  });

  it("retains partial parsed properties when a successful probe cannot establish its version", () => {
    expect(
      probe({
        stdout: Buffer.from(
          "java.home = /selected/jdk\nos.arch = aarch64\nsun.arch.data.model = 64\n",
        ),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "version_unresolved",
        properties: {
          home: "/selected/jdk",
          version: null,
          osArch: "aarch64",
          bits: 64,
        },
        output: { exit_code: 0 },
      },
    });
  });

  it("bounds diagnostic text and preserves examined stream sizes", () => {
    expect(probe({ status: 7, stdout: Buffer.alloc(12000, 65) })).toMatchObject(
      {
        ok: false,
        error: {
          output: {
            stdout: "A".repeat(8192),
            stdout_bytes: 12000,
            stderr_bytes: 0,
            truncated: true,
          },
        },
      },
    );
  });
});

it.each([
  "21garbage",
  "garbage",
  "21.foo",
  "9007199254740993",
  "21.9999999999999999",
  "21+9999999999999999",
  "1.21.0",
  "21.0",
  "021",
])("keeps malformed java.version %s unresolved", (version) => {
  expect(
    probe({
      stdout: Buffer.from(
        `java.home = /selected/jdk\njava.version = ${version}\nsun.arch.data.model = 64\n`,
      ),
    }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "version_unresolved",
      properties: { version, home: "/selected/jdk" },
    },
  });
});

it.each([
  ["21-ea", 21],
  ["21.0.11+9-LTS", 21],
  ["27-internal+0-adhoc.user.build", 27],
  ["1.8.0_452-b09", 8],
] as const)("recognizes the Java major in %s", (version, major) => {
  expect(
    probe({
      stdout: Buffer.from(
        `java.home = /selected/jdk\njava.version = ${version}\nsun.arch.data.model = 64\n`,
      ),
    }),
  ).toMatchObject({ ok: true, value: { version, major } });
});
