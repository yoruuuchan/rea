import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("Electron API identity", () => {
  it("recovers APIs through an ES module default import of Electron", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      import electron from "electron";
      const { ipcMain } = electron;
      new electron.BrowserWindow({ webPreferences: { preload: "./preload.js" } });
      electron.contextBridge.exposeInMainWorld("api", { ping: true });
      electron.ipcRenderer.invoke("default:ping");
      ipcMain.handle("destructured:ping", () => "pong");
      electron.default.ipcMain.handle("nested-default", () => "local");
    `);

    expect(analysis.electron.browser_windows).toMatchObject([
      { preload_path: "./preload.js" },
    ]);
    expect(analysis.electron.context_bridge_apis).toMatchObject([
      { api_key: "api", members: ["ping"] },
    ]);
    expect(
      analysis.electron.ipc.map(({ side, operation, channel }) => ({
        side,
        operation,
        channel,
      })),
    ).toEqual([
      { side: "renderer", operation: "invoke", channel: "default:ping" },
      { side: "main", operation: "handle", channel: "destructured:ping" },
    ]);
  });

  it("recovers APIs and sender checks written with optional chaining", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { contextBridge, ipcMain, utilityProcess } = require("electron");
      contextBridge?.exposeInMainWorld("api", {});
      utilityProcess?.fork("./worker.js");
      ipcMain?.handle("optional:ping", (event) => {
        if (!event.senderFrame?.url.startsWith("file://")) return null;
        return event.sender?.getURL() === "file:///index.html";
      });
    `);

    expect(analysis.electron.context_bridge_apis).toMatchObject([
      { api_key: "api" },
    ]);
    expect(analysis.electron.utility_processes).toMatchObject([
      { module_path: "./worker.js" },
    ]);
    expect(analysis.electron.ipc).toMatchObject([
      { side: "main", operation: "handle", channel: "optional:ping" },
    ]);
    expect(
      analysis.electron.sender_validations.map(
        ({ subject, mechanism, expected }) => ({
          subject,
          mechanism,
          expected: expected.value,
        }),
      ),
    ).toEqual([
      {
        subject: "sender-url",
        mechanism: "call:startsWith",
        expected: "file://",
      },
      {
        subject: "sender-url",
        mechanism: "comparison:===",
        expected: "file:///index.html",
      },
    ]);
  });

  it("follows bundler namespace interop helpers without accepting other writes", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      var __toESM = (mod) => mod;
      var __importStar = (this && this.__importStar) || ((mod) => mod);
      let electron = require("electron");
      electron = __toESM(electron);
      new electron.BrowserWindow({ webPreferences: { preload: "./rolldown.js" } });
      var import_electron = __toESM(require("electron"));
      new import_electron.BrowserWindow({ webPreferences: { preload: "./esbuild.js" } });
      function _interopRequireWildcard(mod) { return mod; }
      const Electron = __importStar(require("electron"));
      new Electron.BrowserWindow({ webPreferences: { preload: "./tsc.js" } });

      let replaced = require("electron");
      replaced = __toESM(require("./fake"));
      new replaced.BrowserWindow({ webPreferences: { preload: "./replaced.js" } });
      let rewritten = require("electron");
      rewritten = __toESM(rewritten);
      rewritten = fake;
      new rewritten.BrowserWindow({ webPreferences: { preload: "./rewritten.js" } });
      const babel = _interopRequireWildcard(require("electron"));
      new babel.BrowserWindow({ webPreferences: { preload: "./babel.js" } });
      function nested() {
        const __toESM = (mod) => mod;
        const scoped = __toESM(require("electron"));
        new scoped.BrowserWindow({ webPreferences: { preload: "./nested.js" } });
      }
    `);

    expect(
      analysis.electron.browser_windows.map(({ preload_path }) => preload_path),
    ).toEqual(["./rolldown.js", "./esbuild.js", "./tsc.js", "./babel.js"]);
  });

  it("does not trust unbound helper names or non-function helper values", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const __toESM = makeLookalike();
      const electron = __toESM(require("electron"));
      new electron.BrowserWindow({});
      let unbound = require("electron");
      unbound = __importStar(unbound);
      new unbound.BrowserWindow({});
    `);

    expect(analysis.electron.browser_windows).toEqual([]);
  });
});
