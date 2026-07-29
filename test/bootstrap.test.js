"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const startBootstrap = require("../src/bootstrap.js");
const startContent = require("../src/content.js");
const transformApi = require("../src/transform.js");

function makeDom(text = "Jan 1") {
  return new JSDOM(`<!doctype html><body><p>${text}</p></body>`, {
    url: "https://example.test/page",
    contentType: "text/html",
    pretendToBeVisual: true,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function makeSettings(readResult) {
  let listener = null;
  let removed = 0;
  let reads = 0;
  return {
    api: {
      addChangeListener(nextListener) {
        listener = nextListener;
        return () => {
          if (listener === nextListener) listener = null;
          removed += 1;
        };
      },
      read() {
        reads += 1;
        return typeof readResult === "function" ? readResult() : readResult;
      },
    },
    emit(state) { if (listener) listener(state); },
    get reads() { return reads; },
    get removed() { return removed; },
  };
}

const enabled = Object.freeze({ enabled: true, valid: true, kind: "boolean" });
const disabled = Object.freeze({ enabled: false, valid: true, kind: "boolean" });

test("bootstrap gates ineligible documents before storage access", async () => {
  const dom = makeDom();
  Object.defineProperty(dom.window.document, "contentType", {
    configurable: true,
    value: "text/plain",
  });
  let listenerCalls = 0;
  const bootstrap = startBootstrap(dom.window, {
    addChangeListener() { listenerCalls += 1; },
    read() { throw new Error("must not read"); },
  }, null, null);
  await bootstrap.ready;
  assert.equal(bootstrap.eligible, false);
  assert.equal(bootstrap.active, false);
  assert.equal(listenerCalls, 0);
  dom.window.close();
});

test("bootstrap ignores a stale initial read and reconciles idempotently", async () => {
  const dom = makeDom();
  const initial = deferred();
  const settings = makeSettings(initial.promise);
  let starts = 0;
  let stops = 0;
  const contentApi = {
    startContent() {
      starts += 1;
      let active = true;
      return {
        get active() { return active; },
        stop() {
          if (!active) return;
          active = false;
          stops += 1;
        },
      };
    },
  };
  const bootstrap = startBootstrap(
    dom.window, settings.api, contentApi, transformApi);
  assert.equal(settings.reads, 1);
  assert.equal(bootstrap.active, false);

  settings.emit(disabled);
  initial.resolve(enabled);
  await bootstrap.ready;
  assert.equal(bootstrap.active, false);
  assert.equal(starts, 0, "stale enabled read must not win");

  settings.emit(enabled);
  settings.emit(enabled);
  assert.equal(bootstrap.active, true);
  assert.equal(starts, 1);
  settings.emit(disabled);
  settings.emit(disabled);
  assert.equal(bootstrap.active, false);
  assert.equal(stops, 1);
  settings.emit(enabled);
  assert.equal(bootstrap.active, true);
  assert.equal(starts, 2);

  bootstrap.stop();
  bootstrap.stop();
  assert.equal(stops, 2);
  assert.equal(settings.removed, 1);
  settings.emit(enabled);
  assert.equal(starts, 2);
  dom.window.close();
});

test("bootstrap fails closed on read and controller startup failures", async () => {
  const readFailureDom = makeDom();
  const readFailureSettings = makeSettings(Promise.reject(new Error("failed")));
  let starts = 0;
  const readFailure = startBootstrap(readFailureDom.window,
    readFailureSettings.api, {
      startContent() { starts += 1; },
    }, transformApi);
  await readFailure.ready;
  assert.equal(readFailure.desiredEnabled, false);
  assert.equal(readFailure.active, false);
  assert.equal(starts, 0);
  readFailure.stop();
  readFailureDom.window.close();

  const startFailureDom = makeDom();
  const startFailureSettings = makeSettings(Promise.resolve(enabled));
  const startFailure = startBootstrap(startFailureDom.window,
    startFailureSettings.api, {
      startContent() { throw new Error("failed"); },
    }, transformApi);
  await startFailure.ready;
  assert.equal(startFailure.desiredEnabled, true);
  assert.equal(startFailure.active, false);
  startFailure.stop();
  startFailureDom.window.close();
});

test("disable discards pending scans and re-enable starts a fresh traversal", async () => {
  const input = `${"x".repeat(100_000)} Jan 1`;
  const dom = makeDom(input);
  const settings = makeSettings(Promise.resolve(enabled));
  const controllers = [];
  const contentApi = {
    startContent(windowObject, api) {
      const controller = startContent(windowObject, api, { manualScheduling: true });
      controllers.push(controller);
      return controller;
    },
  };
  const bootstrap = startBootstrap(dom.window,
    settings.api, contentApi, transformApi);
  await bootstrap.ready;
  assert.equal(controllers.length, 1);
  assert.equal(controllers[0].flushForTest(10), 10);
  assert.equal(dom.window.document.querySelector("p").textContent.endsWith("Jan 1"), true);

  settings.emit(disabled);
  assert.equal(bootstrap.active, false);
  assert.equal(controllers[0].active, false);
  assert.deepEqual(controllers[0].getStats(), {
    pendingEntries: 0,
    pendingMutationRecords: 0,
    observedShadowRoots: 0,
    shadowCoverageLimited: false,
    cooldownNodes: 0,
  });
  controllers[0].flushForTest();
  assert.equal(dom.window.document.querySelector("p").textContent.endsWith("Jan 1"), true);

  settings.emit(enabled);
  assert.equal(controllers.length, 2);
  controllers[1].flushForTest();
  assert.equal(dom.window.document.querySelector("p").textContent.endsWith("01-01"), true);
  bootstrap.stop();
  dom.window.close();
});
