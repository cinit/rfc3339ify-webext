"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const startPopup = require("../src/popup.js");

const projectRoot = path.resolve(__dirname, "..");
const popupHtml = readFileSync(path.join(projectRoot, "src", "popup.html"), "utf8");
const popupCss = readFileSync(path.join(projectRoot, "src", "popup.css"), "utf8");

function state(enabled) {
  return Object.freeze({ enabled, valid: true, kind: "boolean" });
}

const malformed = Object.freeze({
  enabled: false, valid: false, kind: "malformed",
});

function makeSettings(initialState) {
  let currentState = initialState;
  let listener = null;
  let readFailure = false;
  let writeFailure = false;
  const writes = [];
  return {
    api: {
      addChangeListener(nextListener) {
        listener = nextListener;
        return () => { if (listener === nextListener) listener = null; };
      },
      async read() {
        if (readFailure) throw new Error("read failed");
        return currentState;
      },
      async write(enabled) {
        writes.push(enabled);
        if (writeFailure) throw new Error("write failed");
        currentState = state(enabled);
      },
    },
    emit(nextState) {
      currentState = nextState;
      if (listener) listener(nextState);
    },
    setReadFailure(value) { readFailure = value; },
    setWriteFailure(value) { writeFailure = value; },
    writes,
  };
}

function makePopup(settings) {
  const dom = new JSDOM(popupHtml, { url: "moz-extension://test/popup.html" });
  const popup = startPopup(dom.window, dom.window.document, settings.api);
  return { dom, popup };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("popup uses one labeled native checkbox and adaptive system colors", () => {
  const dom = new JSDOM(popupHtml);
  const document = dom.window.document;
  const checkbox = document.querySelector("input#global-enabled[type=checkbox]");
  const label = document.querySelector("label[for=global-enabled]");
  assert.ok(checkbox);
  assert.ok(label);
  assert.equal(label.contains(checkbox), true);
  assert.equal(document.querySelectorAll("input[type=checkbox]").length, 1);
  assert.equal(document.querySelectorAll("script:not([src])").length, 0);
  assert.match(popupCss, /color-scheme:\s*light dark/);
  assert.match(popupCss, /background:\s*Canvas/);
  assert.match(popupCss, /color:\s*CanvasText/);
  assert.match(popupCss, /body\s*{[^}]*min-width:\s*20rem/s);
  assert.match(popupCss, /body\s*{[^}]*min-inline-size:\s*20rem/s);
  assert.match(popupCss, /main\s*{[^}]*inline-size:\s*100%/s);
  assert.doesNotMatch(popupCss, /appearance\s*:/i);
  assert.doesNotMatch(popupCss, /#(?:000(?:000)?|fff(?:fff)?)\b/i);
  dom.window.close();
});

test("popup loads, saves, and follows external changes", async () => {
  const settings = makeSettings(state(true));
  const { dom, popup } = makePopup(settings);
  await popup.ready;
  const checkbox = dom.window.document.querySelector("#global-enabled");
  const status = dom.window.document.querySelector("#status");
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.indeterminate, false);
  assert.equal(checkbox.disabled, false);
  assert.match(status.textContent, /^On/);

  checkbox.checked = false;
  checkbox.dispatchEvent(new dom.window.Event("change"));
  assert.equal(checkbox.disabled, true);
  assert.equal(status.textContent, "Saving…");
  await settle();
  assert.deepEqual(settings.writes, [false]);
  assert.equal(checkbox.disabled, false);
  assert.match(status.textContent, /^Off/);

  settings.emit(state(true));
  assert.equal(checkbox.checked, true);
  assert.match(status.textContent, /^On/);
  popup.stop();
  dom.window.close();
});

test("popup does not let a stale initial read overwrite a change event", async () => {
  const initial = deferred();
  let listener;
  const settings = {
    addChangeListener(nextListener) {
      listener = nextListener;
      return () => { listener = null; };
    },
    read() { return initial.promise; },
    async write() {},
  };
  const dom = new JSDOM(popupHtml, { url: "moz-extension://test/popup.html" });
  const popup = startPopup(dom.window, dom.window.document, settings);
  listener(state(false));
  initial.resolve(state(true));
  await popup.ready;
  const checkbox = dom.window.document.querySelector("#global-enabled");
  assert.equal(checkbox.checked, false);
  assert.match(dom.window.document.querySelector("#status").textContent, /^Off/);
  popup.stop();
  dom.window.close();
});

test("popup exposes explicit malformed, read-error, and write-error recovery", async () => {
  const malformedSettings = makeSettings(malformed);
  const malformedPopup = makePopup(malformedSettings);
  await malformedPopup.popup.ready;
  let document = malformedPopup.dom.window.document;
  assert.equal(document.querySelector("#global-enabled").checked, false);
  assert.match(document.querySelector("#status").textContent, /invalid/);
  assert.equal(document.querySelector("#recovery").textContent, "Reset to Off");
  document.querySelector("#recovery").click();
  await settle();
  assert.deepEqual(malformedSettings.writes, [false]);
  assert.match(document.querySelector("#status").textContent, /^Off/);
  malformedPopup.popup.stop();
  malformedPopup.dom.window.close();

  const readSettings = makeSettings(state(true));
  readSettings.setReadFailure(true);
  const readPopup = makePopup(readSettings);
  await readPopup.popup.ready;
  document = readPopup.dom.window.document;
  assert.equal(document.querySelector("#global-enabled").indeterminate, true);
  assert.equal(document.querySelector("#global-enabled").disabled, true);
  assert.equal(document.querySelector("#recovery").textContent, "Retry");
  readSettings.setReadFailure(false);
  document.querySelector("#recovery").click();
  await settle();
  assert.equal(document.querySelector("#global-enabled").checked, true);
  assert.match(document.querySelector("#status").textContent, /^On/);
  readPopup.popup.stop();
  readPopup.dom.window.close();

  const writeSettings = makeSettings(state(true));
  writeSettings.setWriteFailure(true);
  const writePopup = makePopup(writeSettings);
  await writePopup.popup.ready;
  document = writePopup.dom.window.document;
  const checkbox = document.querySelector("#global-enabled");
  checkbox.checked = false;
  checkbox.dispatchEvent(new writePopup.dom.window.Event("change"));
  await settle();
  assert.equal(checkbox.checked, true, "failed write restores confirmed state");
  assert.equal(document.querySelector("#status").textContent,
    "Could not save the setting.");
  writeSettings.setWriteFailure(false);
  document.querySelector("#recovery").click();
  await settle();
  assert.deepEqual(writeSettings.writes, [false, false]);
  assert.equal(checkbox.checked, false);
  assert.match(document.querySelector("#status").textContent, /^Off/);
  writePopup.popup.stop();
  writePopup.dom.window.close();
});
