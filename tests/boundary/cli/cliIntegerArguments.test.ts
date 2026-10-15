import { describe, expect, it } from "vitest";

import { serveCli } from "./cliServeHarness.js";

const SESSION_ID = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";
const NON_INTEGER_TEXT = [
  "",
  " ",
  "\t",
  "1\n",
  "0x1",
  "0b1",
  "1e0",
  "+1",
  "1.0",
  "9007199254740992",
];
const NON_INTEGER_OPTION_TEXT = [...NON_INTEGER_TEXT, "-0"];

const expectCliValidationError = (
  result: Awaited<ReturnType<typeof serveCli>>,
  field: string,
): void => {
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining(field) }),
    ]),
  });
};

describe("CLI integer arguments", () => {
  it.each(NON_INTEGER_TEXT)(
    "rejects %j as a Cutter expected generation",
    async (value) => {
      const result = await serveCli([
        "cutter-command",
        SESSION_ID,
        value,
        "pdi",
        "--json",
      ]);

      expectCliValidationError(result, "expectedGeneration");
    },
  );

  it.each(NON_INTEGER_TEXT)(
    "rejects %j as a web module script index",
    async (value) => {
      const result = await serveCli([
        "trace-web-module-imports",
        "/nonexistent/manifest.json",
        value,
        "--json",
      ]);

      expectCliValidationError(result, "scriptIndex");
    },
  );

  it.each(NON_INTEGER_OPTION_TEXT)(
    "rejects %j in a repeated web capture record selector",
    async (value) => {
      const result = await serveCli([
        "inspect-web-network-capture",
        "/nonexistent/capture.qlog",
        "qlog",
        "--record",
        "0",
        "--record",
        value,
        "--json",
      ]);

      expectCliValidationError(result, "record");
    },
  );

  it("keeps the one-based source line lower bound at the CLI boundary", async () => {
    const result = await serveCli([
      "trace-web-source-location",
      "/nonexistent/manifest.json",
      "0",
      "/nonexistent/app.js.map",
      "https://example.test/app.js.map",
      "0",
      "0",
      "--json",
    ]);

    expectCliValidationError(result, "line");
  });
});
