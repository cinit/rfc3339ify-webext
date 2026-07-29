import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDirectory = path.join(projectRoot, "dist", "chrome");
const chromeBinary = process.env.CHROME_BINARY;
if (!chromeBinary) {
  throw new Error(
    "Set CHROME_BINARY to Chromium or an official Chrome for Testing executable");
}

const routes = new Map([
  ["/html", {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><body>
      <p id="value">Jan 1, 1990 at 01:00 PM</p>
      <iframe id="plain-frame" src="/plain"></iframe>
      <iframe id="srcdoc-frame" srcdoc="<p id='srcdoc-value'>Feb 2</p>"></iframe>
      <iframe id="blank-frame" src="about:blank"></iframe>
    </body></html>`,
  }],
  ["/xhtml", {
    type: "application/xhtml+xml; charset=utf-8",
    body: `<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><body>
        <p id="value">Tue, 28 Jul 2026 18:00:58 +0000</p>
      </body></html>`,
  }],
  ["/plain", {
    type: "text/plain; charset=utf-8",
    body: "Jan 1, 1990 at 01:00 PM",
  }],
]);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unpackedExtensionId(directory) {
  const digest = createHash("sha256").update(directory).digest();
  let id = "";
  for (let index = 0; index < 16; index += 1) {
    id += String.fromCharCode(97 + (digest[index] >> 4));
    id += String.fromCharCode(97 + (digest[index] & 0x0f));
  }
  return id;
}

async function terminateProcessGroup(child, initialSignal, timeoutMs) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, initialSignal); } catch { return; }
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await delay(100);
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group is gone. */ }
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event.data));
  }

  onMessage(data) {
    const message = JSON.parse(data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const key = `${message.sessionId || "browser"}:${message.method}`;
    const listeners = this.listeners.get(key);
    if (!listeners) return;
    this.listeners.delete(key);
    for (const resolve of listeners) resolve(message.params);
  }

  async send(method, params = {}, sessionId) {
    await this.opened;
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return response;
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "evaluation failed");
  }
  return result.result.value;
}

async function waitForValue(cdp, sessionId, expression, expected, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let actual;
  do {
    actual = await evaluate(cdp, sessionId, expression);
    if (actual === expected) return;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(actual, expected);
}

function waitForDevTools(process, logChunks) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => reject(new Error(
      `Chrome did not expose DevTools:\n${logChunks.join("").slice(-4000)}`)), 10000);
    process.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      logChunks.push(text);
      buffered += text;
      const match = buffered.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
      if (buffered.length > 8000) buffered = buffered.slice(-8000);
    });
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools startup (status ${code})`));
    });
  });
}

const server = http.createServer((request, response) => {
  const route = routes.get(new URL(request.url, "http://localhost").pathname);
  if (!route) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": route.type,
    "cache-control": "no-store",
  });
  response.end(route.body);
});

let chromeProcess;
let cdp;
let popupTargetId;
const chromeLogs = [];
const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "rfc3339ify-chrome-"));

try {
  await listen(server);
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const chromeArguments = [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions-except=" + extensionDirectory,
    "--disable-sync",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDirectory,
    "--load-extension=" + extensionDirectory,
    "about:blank",
  ];
  if (process.env.CHROME_NO_SANDBOX === "1") chromeArguments.push("--no-sandbox");
  chromeProcess = spawn(chromeBinary, chromeArguments, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });

  const browserUrl = await waitForDevTools(chromeProcess, chromeLogs);
  cdp = new CdpConnection(browserUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);

  await cdp.send("Page.navigate", { url: `${origin}/html` }, sessionId);
  await waitForValue(cdp, sessionId,
    "document.querySelector('#value')?.textContent",
    "1990-01-01 at 13:00");
  await waitForValue(cdp, sessionId,
    "document.querySelector('#plain-frame')?.contentDocument?.body?.textContent",
    "Jan 1, 1990 at 01:00 PM");
  await waitForValue(cdp, sessionId,
    "document.querySelector('#srcdoc-frame')?.contentDocument?.body?.textContent.trim()",
    "02-02");

  // Opening the local action page exercises the same popup/storage path as a
  // toolbar click without requiring a background worker or tab permission.
  const extensionId = unpackedExtensionId(extensionDirectory);
  ({ targetId: popupTargetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup.html`,
  }));
  const { sessionId: popupSessionId } = await cdp.send("Target.attachToTarget", {
    targetId: popupTargetId,
    flatten: true,
  });
  await cdp.send("Runtime.enable", {}, popupSessionId);
  await waitForValue(cdp, popupSessionId,
    "document.querySelector('#global-enabled')?.checked", true);
  await waitForValue(cdp, popupSessionId,
    "getComputedStyle(document.body).minWidth", "320px");
  await evaluate(cdp, popupSessionId,
    "document.querySelector('#global-enabled').click()");
  await waitForValue(cdp, popupSessionId,
    "document.querySelector('#status')?.textContent",
    "Off — future changes are stopped. Reload affected tabs to restore text from the page.");
  await evaluate(cdp, sessionId,
    "document.querySelector('#value').firstChild.data = 'Mar 3'");
  await delay(250);
  assert.equal(await evaluate(cdp, sessionId,
    "document.querySelector('#value')?.textContent"), "Mar 3");
  await evaluate(cdp, popupSessionId,
    "document.querySelector('#global-enabled').click()");
  await waitForValue(cdp, popupSessionId,
    "document.querySelector('#status')?.textContent",
    "On — applies to all eligible pages in this browser.");
  await waitForValue(cdp, sessionId,
    "document.querySelector('#value')?.textContent", "03-03");

  await evaluate(cdp, sessionId,
    "document.querySelector('#blank-frame').contentDocument.body.textContent = 'Mar 3'");
  await waitForValue(cdp, sessionId,
    "document.querySelector('#blank-frame')?.contentDocument?.body?.textContent",
    "03-03");

  await evaluate(cdp, sessionId, `(() => {
    const frame = document.createElement("iframe");
    frame.id = "blob-frame";
    frame.src = URL.createObjectURL(new Blob(
      ["<!doctype html><body><p>Apr 4</p></body>"],
      { type: "text/html" }));
    document.body.append(frame);
  })()`);
  await waitForValue(cdp, sessionId,
    "document.querySelector('#blob-frame')?.contentDocument?.body?.textContent",
    "04-04");

  await evaluate(cdp, sessionId,
    "document.querySelector('#value').firstChild.data = 'Feb 2 at 02:00 AM'");
  await waitForValue(cdp, sessionId,
    "document.querySelector('#value')?.textContent",
    "02-02 at 02:00");

  await cdp.send("Page.navigate", { url: `${origin}/xhtml` }, sessionId);
  await waitForValue(cdp, sessionId,
    "document.getElementById('value')?.textContent",
    "Tue, 2026-07-28 18:00:58 +0000");

  await cdp.send("Page.navigate", { url: `${origin}/plain` }, sessionId);
  await waitForValue(cdp, sessionId, "document.body?.textContent",
    "Jan 1, 1990 at 01:00 PM");
  await delay(250);
  assert.equal(await evaluate(cdp, sessionId, "document.body?.textContent"),
    "Jan 1, 1990 at 01:00 PM");
} catch (error) {
  if (chromeLogs.length) {
    error.message += `\nChrome log tail:\n${chromeLogs.join("").slice(-4000)}`;
  }
  throw error;
} finally {
  if (cdp && popupTargetId) {
    try {
      await cdp.send("Target.closeTarget", { targetId: popupTargetId });
    } catch { /* Browser may already be closing. */ }
  }
  if (cdp) cdp.close();
  await terminateProcessGroup(chromeProcess, "SIGTERM", 3000);
  await new Promise((resolve) => server.close(resolve));
  await rm(profileDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
