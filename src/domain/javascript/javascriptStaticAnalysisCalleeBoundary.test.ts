import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const expressionWrappers = [
  ["plain", (value: string) => value],
  ["asserted", (value: string) => `(${value} as any)`],
  ["non-null", (value: string) => `(${value}!)`],
  ["satisfies", (value: string) => `(${value} satisfies any)`],
] as const;

it("shares erased call-target names with endpoint consumers without inventing dynamic keys", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    (client.get as typeof client.get)("/api/items");
    (navigator as typeof navigator).sendBeacon("/api/telemetry", payload);
    (client[method] as typeof client.get)("/api/unknown");
    ((choose ? client.get : client.post) as typeof client.get)("/api/conditional");
  `);
  expect(analysis.parse_error_count).toBe(0);
  expect(
    analysis.endpoints.map(({ value, mechanism }) => [value, mechanism]),
  ).toEqual([
    ["/api/items", "call:client.get"],
    ["/api/telemetry", "call:navigator.sendBeacon"],
  ]);
});

it.each(expressionWrappers)(
  "excludes %s collection and configuration reads while retaining request candidates",
  (_label, wrap) => {
    const call = (receiver: string, method: string, value: string) =>
      `${wrap(`${wrap(receiver)}.${method}`)}(${JSON.stringify(value)});`;
    const workspace = `${wrap("vscode")}.workspace`;
    const configuration = `${wrap(`${wrap(workspace)}.getConfiguration`)}("editor")`;
    const analysis = analyzeJavaScriptStaticSource(`
    import * as vscode from "vscode";
    const settings = ${wrap(configuration)};
    let changed = ${wrap(configuration)};
    changed = client;
    const uncertain = flag ? ${wrap(configuration)} : client;
    ${call(`new ${wrap("Headers")}()`, "get", "content-type")}
    ${call(`new ${wrap("URLSearchParams")}()`, "delete", "q")}
    ${call(`new ${wrap("Map")}()`, "get", "setting")}
    ${call(`${wrap("response")}.headers`, "get", "authorization")}
    ${call(`${wrap("url")}.searchParams`, "delete", "token")}
    ${call(configuration, "get", "tabSize")}
    ${call("settings", "get", "wordWrap")}
    ${call(`${wrap("context")}.globalState`, "get", "lastSession")}
    ${call(`${wrap("context")}.workspaceState`, "get", "lastFile")}
    ${call("client", "get", "setting")}
    ${call(`new ${wrap("Headers")}()`, "get", "/api/header-shaped")}
    ${call("settings", "get", "https://api.example.test/config-shaped")}
    ${call("client", "get", "/api/items")}
    ${call("changed", "get", "changed-setting")}
    ${call("uncertain", "get", "conditional-setting")}
  `);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.parse_status).toBe("complete");
    expect(
      analysis.endpoints.map(({ value, interpretation }) => [
        value,
        interpretation ?? null,
      ]),
    ).toEqual([
      ["setting", "candidate"],
      ["/api/header-shaped", null],
      ["https://api.example.test/config-shaped", null],
      ["/api/items", null],
      ["changed-setting", "candidate"],
      ["conditional-setting", "candidate"],
    ]);
  },
);

it("retains uncertainty and module evidence for wrapped get receivers", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const vscode = otherLibrary;
    const settings = vscode.workspace.getConfiguration("editor");
    (settings.get as any)("unproven-config");
    (context.globalState.get as any)("unproven-state");
    ((choose ? new Headers() : client).get as any)("uncertain-receiver");
    (client[method] as any)("unknown-method");
    ((choose ? client.get : client.post) as any)("unknown-target");
  `);
  expect(analysis.parse_error_count).toBe(0);
  expect(
    analysis.endpoints.map(({ value, interpretation }) => [
      value,
      interpretation,
    ]),
  ).toEqual([
    ["unproven-config", "candidate"],
    ["unproven-state", "candidate"],
    ["uncertain-receiver", "candidate"],
  ]);
});

it("retains lexical browser-open facts through erased call and receiver wrappers", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    ((window as any).open as any)(method, "browser-context");
    function local(window) {
      ((window as any).open as any)(method, "local-request");
    }
  `);
  expect(analysis.parse_error_count).toBe(0);
  expect(
    analysis.endpoints.map(({ value, interpretation }) => [
      value,
      interpretation,
    ]),
  ).toEqual([["local-request", "candidate"]]);
});

it.each(expressionWrappers)(
  "retains global and local identity through %s alias initializers",
  (_label, wrap) => {
    const analysis = analyzeJavaScriptStaticSource(`
    const browser = ${wrap("window")};
    (browser.open as any)(method, "browser-context");
    const database = ${wrap("indexedDB")};
    (database.open as any)("fixture-db", "2");
    const cache = ${wrap("caches")};
    (cache.open as any)("fixture-cache");
    {
      const indexedDB = ${wrap("caches")};
      const nested = ${wrap("indexedDB")};
      (nested.open as any)("nested-cache");
    }
    {
      const caches = ${wrap("indexedDB")};
      const nested = ${wrap("caches")};
      (nested.open as any)("nested-db", "2");
    }
    function local(window, indexedDB, caches) {
      const browser = ${wrap("window")};
      (browser.open as any)(method, "local-window");
      const database = ${wrap("indexedDB")};
      (database.open as any)("GET", "/local-db");
      const cache = ${wrap("caches")};
      (cache.open as any)("GET", "/local-cache");
    }
    let replaced = ${wrap("window")};
    replaced = client;
    (replaced.open as any)(method, "changed-window");
    const uncertain = ${wrap("flag ? window : client")};
    (uncertain.open as any)(method, "uncertain-window");
  `);
    expect(analysis.parse_error_count).toBe(0);
    expect
      .soft(
        analysis.endpoints.map(({ value, interpretation }) => [
          value,
          interpretation ?? null,
        ]),
      )
      .toEqual([
        ["local-window", "candidate"],
        ["/local-db", null],
        ["/local-cache", null],
        ["changed-window", "candidate"],
        ["uncertain-window", "candidate"],
      ]);
    expect(analysis.storage.map(({ kind, name }) => [kind, name])).toEqual([
      ["indexed-db", "fixture-db"],
      ["cache-storage", "fixture-cache"],
      ["cache-storage", "nested-cache"],
      ["indexed-db", "nested-db"],
    ]);
  },
);

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
