/*
 * Race-safe global enable/disable bootstrap for RFC3339ify.
 */
(function exposeBootstrap(globalObject, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory;
  } else {
    factory(
      globalObject,
      globalObject.RFC3339ifySettings,
      globalObject.RFC3339ifyContent,
      globalObject.RFC3339ifyTransform);
  }
})(typeof globalThis === "object" ? globalThis : this,
  function startBootstrap(windowObject, settingsApi, contentApi, transformApi) {
    "use strict";

    function makeInactive(eligible) {
      return Object.freeze({
        eligible,
        active: false,
        desiredEnabled: false,
        ready: Promise.resolve(),
        stop() {},
      });
    }

    if (!windowObject || !windowObject.document) return makeInactive(false);
    const documentObject = windowObject.document;
    const contentType = documentObject.contentType;
    let isTopLevel = false;
    try {
      isTopLevel = windowObject.top === windowObject;
    } catch {
      isTopLevel = false;
    }
    const protocol = windowObject.location && windowObject.location.protocol;
    if ((contentType !== "text/html" && contentType !== "application/xhtml+xml") ||
      (isTopLevel && protocol !== "http:" && protocol !== "https:")) {
      return makeInactive(false);
    }

    let stopped = false;
    let revision = 0;
    let desiredEnabled = false;
    let controller = null;
    let removeChangeListener = null;

    function stopController() {
      if (!controller) return;
      const previous = controller;
      controller = null;
      try { previous.stop(); } catch { /* Remain fail-closed. */ }
    }

    function reconcile(state) {
      if (stopped) return;
      const enabled = Boolean(state && state.enabled === true);
      desiredEnabled = enabled;
      if (!enabled) {
        stopController();
        return;
      }
      if (controller) return;
      try {
        if (!contentApi || typeof contentApi.startContent !== "function") return;
        const candidate = contentApi.startContent(windowObject, transformApi);
        if (candidate && candidate.active === true &&
          typeof candidate.stop === "function") {
          controller = candidate;
        }
      } catch {
        controller = null;
      }
    }

    try {
      if (!settingsApi || typeof settingsApi.addChangeListener !== "function" ||
        typeof settingsApi.read !== "function") {
        return makeInactive(true);
      }
      removeChangeListener = settingsApi.addChangeListener((state) => {
        if (stopped) return;
        revision += 1;
        reconcile(state);
      });
    } catch {
      return makeInactive(true);
    }

    const readRevision = revision;
    let readPromise;
    try {
      readPromise = settingsApi.read();
    } catch (error) {
      readPromise = Promise.reject(error);
    }
    const ready = Promise.resolve(readPromise).then(
      (state) => {
        if (!stopped && revision === readRevision) reconcile(state);
      },
      () => {
        if (!stopped && revision === readRevision) reconcile(null);
      });

    function stop() {
      if (stopped) return;
      stopped = true;
      revision += 1;
      desiredEnabled = false;
      stopController();
      if (removeChangeListener) {
        try { removeChangeListener(); } catch { /* Context is stopping. */ }
        removeChangeListener = null;
      }
    }

    return Object.freeze({
      eligible: true,
      get active() { return controller !== null; },
      get desiredEnabled() { return desiredEnabled; },
      ready,
      stop,
    });
  });
