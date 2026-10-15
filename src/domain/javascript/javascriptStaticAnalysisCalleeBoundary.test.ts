import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it("retains endpoint observations for exact template and TypeScript member keys", () => {
  for (const [get, beacon] of [
    ['"get"', '"sendBeacon"'],
    ["`get`", "`sendBeacon`"],
    ['"get" as const', '"sendBeacon" as const'],
  ]) {
    const analysis = analyzeJavaScriptStaticSource(`
        import * as vscode from "vscode";
        client[${get}]("/api/items");
        navigator[${beacon}]("/api/telemetry", payload);
        client[${get}]("setting");
        new Headers()[${get}]("content-type");
        new URLSearchParams()[${get}]("q");
        vscode.workspace.getConfiguration("editor")[${get}]("tabSize");
      `);

    expect.soft(analysis.parse_error_count).toBe(0);
    expect.soft(analysis.parse_status).toBe("complete");
    expect
      .soft(
        analysis.endpoints.map(({ kind, value, mechanism, interpretation }) => [
          kind,
          value,
          mechanism,
          interpretation ?? null,
        ]),
      )
      .toEqual([
        ["network", "/api/items", "call:client.get", null],
        ["network", "/api/telemetry", "call:navigator.sendBeacon", null],
        ["network", "setting", "call:client.get", "candidate"],
      ]);
  }
});

it("preserves preload and utility paths through exact computed join members", () => {
  for (const key of ['"join"', "`join`", '"join" as const']) {
    const analysis = analyzeJavaScriptStaticSource(`
        const { BrowserWindow, utilityProcess } = require("electron");
        const path = require("node:path");
        new BrowserWindow({ webPreferences: {
          preload: path[${key}](__dirname, "preload.js")
        } });
        utilityProcess.fork(path[${key}](__dirname, "worker.js"), [], {
          serviceName: "kept"
        });
      `);

    expect.soft(analysis.parse_error_count).toBe(0);
    expect.soft(analysis.parse_status).toBe("complete");
    expect
      .soft(
        analysis.role_paths.map(
          ({ role, path, resolution_context, mechanism }) => [
            role,
            path,
            resolution_context,
            mechanism,
          ],
        ),
      )
      .toEqual([
        ["preload", "preload.js", "filesystem-expression", "property:preload"],
      ]);
    expect
      .soft(
        analysis.electron.browser_windows.map(
          ({ location: _location, ...finding }) => finding,
        ),
      )
      .toEqual([
        {
          options_status: "object-literal",
          web_preferences_status: "object-literal",
          web_preferences: [
            {
              name: "preload",
              value: {
                status: "literal",
                value: "preload.js",
                expression: null,
              },
            },
          ],
          preload_path: "preload.js",
          preload_resolution_context: "filesystem-expression",
          module_key: null,
        },
      ]);
    expect
      .soft(
        analysis.electron.utility_processes.map(
          ({ location: _location, ...finding }) => finding,
        ),
      )
      .toEqual([
        {
          module_path: "worker.js",
          module_resolution_context: "filesystem-expression",
          module_expression: null,
          service_name: "kept",
          module_key: null,
        },
      ]);
  }
});

it("keeps dynamic, interpolated, and invalid template keys unresolved", () => {
  for (const { key, errors } of [
    { key: "method", errors: 0 },
    { key: "`join${suffix}`", errors: 0 },
    { key: ["`", String.raw`\unicode`, "`"].join(""), errors: 4 },
  ]) {
    const preload = `path[${key}](__dirname, "preload.js")`;
    const worker = `path[${key}](__dirname, "worker.js")`;
    const analysis = analyzeJavaScriptStaticSource(`
        const { BrowserWindow, utilityProcess } = require("electron");
        const path = require("node:path");
        client[${key}]("/api/items");
        navigator[${key}]("/api/telemetry", payload);
        new BrowserWindow({ webPreferences: { preload: ${preload} } });
        utilityProcess.fork(${worker}, [], { serviceName: "kept" });
      `);

    expect.soft(analysis.parse_error_count).toBe(errors);
    expect.soft(analysis.parse_status).toBe("partial");
    expect.soft(analysis.endpoints).toEqual([]);
    expect.soft(analysis.role_paths).toEqual([]);
    expect
      .soft(
        analysis.electron.browser_windows.map(
          ({ location: _location, ...finding }) => finding,
        ),
      )
      .toEqual([
        {
          options_status: "object-literal",
          web_preferences_status: "object-literal",
          web_preferences: [
            {
              name: "preload",
              value: { status: "dynamic", value: null, expression: preload },
            },
          ],
          preload_path: null,
          preload_resolution_context: null,
          module_key: null,
        },
      ]);
    expect
      .soft(
        analysis.electron.utility_processes.map(
          ({ location: _location, ...finding }) => finding,
        ),
      )
      .toEqual([
        {
          module_path: null,
          module_resolution_context: null,
          module_expression: worker,
          service_name: "kept",
          module_key: null,
        },
      ]);
  }
});

describe("static callee boundary matching", () => {
  it("matches complete callee members without suffix collisions", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      win.loadFile("./window.html");
      BrowserWindow.loadURL("https://app.example.test");
      navigator.serviceWorker.register("./worker.js");
      loadFile("./bare.html");
      win?.loadURL("https://optional.example.test");

      uploadFile("./upload.html");
      preloadFile("./preload.html");
      downloadURL("https://download.example.test");
      reloadURL("https://reload.example.test");
      notloadURL("https://other.example.test");
      myserviceWorker.register("./not-worker.js");
    `);

    expect(
      analysis.role_paths.map(({ path, mechanism }) => [path, mechanism]),
    ).toEqual([
      ["./window.html", "call:win.loadFile"],
      ["https://app.example.test", "call:BrowserWindow.loadURL"],
      ["./bare.html", "call:loadFile"],
      ["https://optional.example.test", "call:win.loadURL"],
    ]);
    // The document base URL is unknown, so the script path stays unresolved.
    expect(
      analysis.references
        .filter(({ kind }) => kind === "service-worker")
        .map(({ specifier, expression }) => [specifier, expression]),
    ).toEqual([[null, 'navigator.serviceWorker.register("./worker.js")']]);
    expect(
      analysis.endpoints
        .filter(({ mechanism }) => mechanism.endsWith("loadURL"))
        .map(({ value }) => value),
    ).toEqual(["https://app.example.test", "https://optional.example.test"]);
  });
});
