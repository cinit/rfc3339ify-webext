"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const createSettings = require("../src/settings.js");

function makeEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(changes, areaName = "local") {
      for (const listener of [...listeners]) listener(changes, areaName);
    },
    get size() { return listeners.size; },
  };
}

test("settings decoder is default-on and rejects malformed values", () => {
  const settings = createSettings({});
  assert.deepEqual(settings.decodeSnapshot({}), {
    enabled: true, valid: true, kind: "absent",
  });
  assert.deepEqual(settings.decodeSnapshot({ globalEnabled: true }), {
    enabled: true, valid: true, kind: "boolean",
  });
  assert.deepEqual(settings.decodeSnapshot({ globalEnabled: false }), {
    enabled: false, valid: true, kind: "boolean",
  });
  for (const value of [null, 0, 1, "true", {}, []]) {
    assert.deepEqual(settings.decodeSnapshot({ globalEnabled: value }), {
      enabled: false, valid: false, kind: "malformed",
    });
  }
  assert.deepEqual(settings.decodeSnapshot(null), {
    enabled: false, valid: false, kind: "malformed",
  });
  assert.deepEqual(settings.decodeChange({ oldValue: false }), {
    enabled: true, valid: true, kind: "absent",
  });
  assert.deepEqual(settings.decodeChange({ newValue: undefined }), {
    enabled: true, valid: true, kind: "absent",
  });
});

test("promise-style storage reads, writes, and filters change events", async () => {
  const onChanged = makeEvent();
  const stored = {};
  const settings = createSettings({
    browser: {
      storage: {
        local: {
          async get(key) {
            return Object.hasOwn(stored, key) ? { [key]: stored[key] } : {};
          },
          async set(update) { Object.assign(stored, update); },
        },
        onChanged,
      },
    },
  });

  assert.equal((await settings.read()).enabled, true);
  await settings.write(false);
  assert.deepEqual(stored, { globalEnabled: false });
  assert.equal((await settings.read()).enabled, false);
  await assert.rejects(settings.write("false"), /must be a Boolean/);

  const changes = [];
  const remove = settings.addChangeListener((state) => changes.push(state));
  onChanged.emit({ other: { newValue: true } });
  onChanged.emit({ globalEnabled: { newValue: true } }, "sync");
  onChanged.emit({ globalEnabled: { newValue: true } });
  onChanged.emit({ globalEnabled: { oldValue: true } });
  assert.deepEqual(changes.map((state) => [state.enabled, state.kind]), [
    [true, "boolean"],
    [true, "absent"],
  ]);
  remove();
  remove();
  assert.equal(onChanged.size, 0);
});

test("callback-style storage observes runtime errors", async () => {
  const onChanged = makeEvent();
  const stored = { globalEnabled: true };
  const runtime = { lastError: null };
  let failRead = false;
  let failWrite = false;
  const settings = createSettings({
    chrome: {
      runtime,
      storage: {
        local: {
          get(key, callback) {
            if (failRead) runtime.lastError = { message: "read failed" };
            callback({ [key]: stored[key] });
            runtime.lastError = null;
          },
          set(update, callback) {
            if (failWrite) runtime.lastError = { message: "write failed" };
            else Object.assign(stored, update);
            callback();
            runtime.lastError = null;
          },
        },
        onChanged,
      },
    },
  });

  assert.equal((await settings.read()).enabled, true);
  await settings.write(false);
  assert.equal(stored.globalEnabled, false);
  failRead = true;
  await assert.rejects(settings.read(), /read failed/);
  failRead = false;
  failWrite = true;
  await assert.rejects(settings.write(true), /write failed/);
  assert.equal(stored.globalEnabled, false);
});
