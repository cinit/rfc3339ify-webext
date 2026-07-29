/*
 * One-key extension settings adapter for RFC3339ify.
 *
 * The module performs no work when loaded. Its callers explicitly read,
 * write, and subscribe after applying their own document/context gates.
 */
(function exposeSettings(globalObject, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory;
  } else {
    globalObject.RFC3339ifySettings = factory(globalObject);
  }
})(typeof globalThis === "object" ? globalThis : this,
  function createSettings(globalObject) {
    "use strict";

    const SETTING_KEY = "globalEnabled";
    const ABSENT = Object.freeze({ enabled: true, valid: true, kind: "absent" });
    const ENABLED = Object.freeze({ enabled: true, valid: true, kind: "boolean" });
    const DISABLED = Object.freeze({ enabled: false, valid: true, kind: "boolean" });
    const MALFORMED = Object.freeze({ enabled: false, valid: false, kind: "malformed" });

    const extensionApi = globalObject &&
      (globalObject.browser || globalObject.chrome);
    const promiseStyle = Boolean(globalObject && globalObject.browser &&
      extensionApi === globalObject.browser);

    function hasOwn(value, key) {
      return value !== null && typeof value === "object" &&
        Object.prototype.hasOwnProperty.call(value, key);
    }

    function decodeValue(value) {
      if (value === true) return ENABLED;
      if (value === false) return DISABLED;
      return MALFORMED;
    }

    function decodeSnapshot(snapshot) {
      if (snapshot === null || typeof snapshot !== "object") return MALFORMED;
      if (!hasOwn(snapshot, SETTING_KEY)) return ABSENT;
      return decodeValue(snapshot[SETTING_KEY]);
    }

    function decodeChange(change) {
      if (change === null || typeof change !== "object") return MALFORMED;
      if (!hasOwn(change, "newValue") || change.newValue === undefined) return ABSENT;
      return decodeValue(change.newValue);
    }

    function requireStorage() {
      if (!extensionApi || !extensionApi.storage ||
        !extensionApi.storage.local || !extensionApi.storage.onChanged) {
        throw new Error("WebExtension storage API is unavailable");
      }
      return extensionApi.storage;
    }

    function callbackError() {
      const runtime = extensionApi && extensionApi.runtime;
      const lastError = runtime && runtime.lastError;
      return lastError ? new Error(lastError.message || "Extension storage failed") : null;
    }

    function read() {
      let storage;
      try {
        storage = requireStorage();
        if (promiseStyle) {
          return Promise.resolve(storage.local.get(SETTING_KEY)).then(decodeSnapshot);
        }
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        try {
          storage.local.get(SETTING_KEY, (snapshot) => {
            const error = callbackError();
            if (error) reject(error);
            else resolve(decodeSnapshot(snapshot));
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    function write(enabled) {
      if (typeof enabled !== "boolean") {
        return Promise.reject(new TypeError("globalEnabled must be a Boolean"));
      }

      let storage;
      const update = { [SETTING_KEY]: enabled };
      try {
        storage = requireStorage();
        if (promiseStyle) return Promise.resolve(storage.local.set(update));
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        try {
          storage.local.set(update, () => {
            const error = callbackError();
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    function addChangeListener(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      const storage = requireStorage();
      const onChanged = storage.onChanged;
      if (typeof onChanged.addListener !== "function" ||
        typeof onChanged.removeListener !== "function") {
        throw new Error("WebExtension storage change event is unavailable");
      }

      function handleChange(changes, areaName) {
        if (areaName !== "local" || !hasOwn(changes, SETTING_KEY)) return;
        listener(decodeChange(changes[SETTING_KEY]));
      }

      onChanged.addListener(handleChange);
      let listening = true;
      return function removeChangeListener() {
        if (!listening) return;
        listening = false;
        onChanged.removeListener(handleChange);
      };
    }

    return Object.freeze({
      SETTING_KEY,
      addChangeListener,
      decodeChange,
      decodeSnapshot,
      read,
      write,
    });
  });
