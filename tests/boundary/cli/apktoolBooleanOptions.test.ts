import { expect, it } from "vitest";

import { invokeApktoolCli } from "../../support/cli/apktoolCli.js";

it("dispatches --no-strings as include_strings false", async () => {
  const result = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--no-strings",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: { path: "/targets/app.apk", include_strings: false },
    },
  ]);
});

it("keeps string projection enabled when the flag is omitted", async () => {
  const result = await invokeApktoolCli([
    "decode-android-resources",
    "/targets/app.apk",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: { path: "/targets/app.apk", include_strings: true },
    },
  ]);
});

it("documents the supported negative flag in command help", async () => {
  const result = await invokeApktoolCli(["decode-android-resources", "--help"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--no-strings");
});
