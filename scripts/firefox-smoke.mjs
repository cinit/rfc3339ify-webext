import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDirectory = path.join(projectRoot, "dist", "firefox");
const firefoxBinary = process.env.FIREFOX_BINARY || "firefox";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

let resolveReport;
let rejectReport;
const reportPromise = new Promise((resolve, reject) => {
  resolveReport = resolve;
  rejectReport = reject;
});

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/report" && request.method === "POST") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolveReport(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(204).end();
      } catch (error) {
        rejectReport(error);
        response.writeHead(400).end();
      }
    });
    return;
  }

  if (pathname === "/plain") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Jan 1, 1990 at 01:00 PM");
    return;
  }

  if (pathname === "/xhtml") {
    response.writeHead(200, { "content-type": "application/xhtml+xml; charset=utf-8" });
    response.end(`<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><body>
        <p id="xhtml-value">Tue, 28 Jul 2026 18:00:58 +0000</p>
      </body></html>`);
    return;
  }

  if (pathname === "/html") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html><html><body>
      <p id="value">Jan 1, 1990 at 01:00 PM</p>
      <iframe id="plain" src="/plain"></iframe>
      <iframe id="xhtml" src="/xhtml"></iframe>
      <script>
        (() => {
          let dynamicStarted = false;
          let reported = false;
          const timer = setInterval(async () => {
            if (reported) return;
            const value = document.querySelector("#value");
            const plain = document.querySelector("#plain").contentDocument;
            const xhtml = document.querySelector("#xhtml").contentDocument;
            if (!plain || !xhtml || !plain.body || !xhtml.getElementById("xhtml-value")) return;
            if (plain.body.textContent !== "Jan 1, 1990 at 01:00 PM") return;
            if (xhtml.getElementById("xhtml-value").textContent !==
              "Tue, 2026-07-28 18:00:58 +0000") return;
            if (!dynamicStarted) {
              if (value.textContent !== "1990-01-01 at 13:00") return;
              dynamicStarted = true;
              value.firstChild.data = "Feb 2 at 02:00 AM";
              return;
            }
            if (value.textContent !== "02-02 at 02:00") return;
            reported = true;
            clearInterval(timer);
            await fetch("/report", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                html: document.contentType,
                plain: plain.contentType,
                xhtml: xhtml.contentType,
                value: value.textContent,
              }),
            });
          }, 25);
        })();
      </script>
    </body></html>`);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

let webExtProcess;
let testTimeoutHandle;
const output = [];
try {
  await listen(server);
  const address = server.address();
  const startUrl = `http://127.0.0.1:${address.port}/html`;
  webExtProcess = spawn("npx", [
    "--yes",
    "web-ext@10.5.0",
    "run",
    "--source-dir", extensionDirectory,
    "--firefox", firefoxBinary,
    "--args=-headless",
    "--no-reload",
    "--start-url", startUrl,
  ], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  webExtProcess.stdout.on("data", (chunk) => output.push(chunk.toString()));
  webExtProcess.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const earlyExit = new Promise((_, reject) => {
    webExtProcess.once("error", reject);
    webExtProcess.once("exit", (code) => reject(new Error(
      `web-ext exited before the fixture reported success (status ${code})`)));
  });
  const timeout = new Promise((_, reject) => {
    testTimeoutHandle = setTimeout(() => {
      reject(new Error("Firefox smoke test timed out"));
    }, 30_000);
  });
  const report = await Promise.race([reportPromise, earlyExit, timeout]);
  assert.deepEqual(report, {
    html: "text/html",
    plain: "text/plain",
    xhtml: "application/xhtml+xml",
    value: "02-02 at 02:00",
  });
} catch (error) {
  if (output.length) error.message += `\nweb-ext log tail:\n${output.join("").slice(-5000)}`;
  throw error;
} finally {
  if (testTimeoutHandle) clearTimeout(testTimeoutHandle);
  await terminateProcessGroup(webExtProcess, "SIGINT", 5000);
  await new Promise((resolve) => server.close(resolve));
}
