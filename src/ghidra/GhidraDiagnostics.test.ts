import { expect, it } from "vitest";
import { createGhidraDiagnostics } from "./GhidraDiagnostics.js";

it("does not reuse historical operation-scoped failure output without a current owner", () => {
  const diagnostics = createGhidraDiagnostics({
    targetPath: "/tmp/target",
    targetSha256: "a".repeat(64),
    transport: "unix-socket",
    providerVersion: "11.4",
    profileDigest: "b".repeat(64),
    previous: {
      stdout: { text: "historical OOME" },
      failure_output: {
        stdout: { text: "historical OOME" },
        stderr: { text: "" },
        complete: true,
      },
    },
  });

  expect(diagnostics.stdout).toEqual({ text: "historical OOME" });
  expect(diagnostics).not.toHaveProperty("failure_output");
});
