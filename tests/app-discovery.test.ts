import assert from "node:assert/strict";
import test from "node:test";
import { createAppDiscovery } from "../src/runtime/appDiscovery.js";

test("app discovery finds configured Linux commands on PATH and preserves configured names", async () => {
  const checked: string[] = [];
  const discovery = createAppDiscovery({
    platform: "linux",
    env: { PATH: "/usr/bin:/opt/browser" },
    isExecutableFile: async (candidate) => {
      checked.push(candidate);
      return candidate === "/opt/browser/google-chrome";
    }
  });

  assert.deepEqual(
    await discovery.discover({ commands: ["google-chrome", "chromium"], aliases: {} }),
    ["google-chrome"]
  );
  assert.ok(checked.includes("/opt/browser/google-chrome"));

  const unconfigured = await discovery.resolveConfigured(
    "firefox",
    { commands: ["google-chrome"], aliases: {} }
  );
  assert.deepEqual(unconfigured, { configured: false });
});

test("Windows aliases override duplicate commands and remain case-insensitive", async () => {
  const registeredPath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const heliumPath = "C:\\Apps\\Helium\\chrome.exe";
  const queried: string[] = [];
  const discovery = createAppDiscovery({
    platform: "win32",
    env: { PATH: "", SystemRoot: "C:\\Windows" },
    isExecutableFile: async (candidate) => candidate === registeredPath || candidate === heliumPath,
    queryWindowsAppPath: async (command) => {
      queried.push(command);
      return command.toLowerCase() === "chrome.exe" ? registeredPath : null;
    }
  });
  const config = {
    commands: ["chrome.exe", "msedge.exe"],
    aliases: {
      "Chrome.exe": heliumPath,
      helium: heliumPath
    }
  };

  assert.deepEqual(await discovery.discover(config), ["Chrome.exe", "helium"]);
  assert.deepEqual(
    await discovery.resolveConfigured("CHROME.EXE", config),
    { configured: true, executablePath: heliumPath }
  );
  assert.deepEqual(queried, ["msedge.exe"]);
});

test("invalid aliases fail without falling back to duplicate command discovery", async () => {
  let commandLookupAttempted = false;
  const discovery = createAppDiscovery({
    platform: "win32",
    env: { PATH: "", SystemRoot: "C:\\Windows" },
    isExecutableFile: async () => false,
    queryWindowsAppPath: async () => {
      commandLookupAttempted = true;
      return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    }
  });
  const config = {
    commands: ["chrome.exe"],
    aliases: { "CHROME.EXE": "C:\\Missing\\chrome.exe" }
  };

  assert.deepEqual(await discovery.discover(config), []);
  assert.deepEqual(
    await discovery.resolveConfigured("chrome.exe", config),
    { configured: true, executablePath: null }
  );
  assert.equal(commandLookupAttempted, false);
});
