/*
 * Minimal global enable/disable action popup for RFC3339ify.
 */
(function exposePopup(globalObject, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory;
  } else {
    factory(globalObject, globalObject.document, globalObject.RFC3339ifySettings);
  }
})(typeof globalThis === "object" ? globalThis : this,
  function startPopup(windowObject, documentObject, settingsApi) {
    "use strict";

    const checkbox = documentObject && documentObject.getElementById("global-enabled");
    const status = documentObject && documentObject.getElementById("status");
    const recovery = documentObject && documentObject.getElementById("recovery");
    if (!checkbox || !status || !recovery) {
      return Object.freeze({ ready: Promise.resolve(), stop() {} });
    }

    const ON_TEXT = "On — applies to all eligible pages in this browser.";
    const OFF_TEXT = "Off — future changes are stopped. Reload affected tabs to restore text from the page.";
    const INVALID_TEXT = "Stored setting is invalid; normalization is treated as off.";
    const READ_ERROR_TEXT = "Could not read the setting.";
    const WRITE_ERROR_TEXT = "Could not save the setting.";

    let stopped = false;
    let revision = 0;
    let operation = 0;
    let phase = "loading";
    let pendingState = null;
    let lastSnapshot = null;
    let recoveryMode = "read";
    let failedDesired = null;
    let removeChangeListener = null;

    function setRecovery(mode, label) {
      recoveryMode = mode;
      recovery.textContent = label;
      recovery.hidden = false;
    }

    function hideRecovery() {
      recovery.hidden = true;
    }

    function renderState(state) {
      phase = "idle";
      pendingState = null;
      failedDesired = null;
      lastSnapshot = state;
      checkbox.indeterminate = false;
      checkbox.disabled = false;
      hideRecovery();
      if (state && state.valid === true) {
        checkbox.checked = state.enabled === true;
        status.textContent = checkbox.checked ? ON_TEXT : OFF_TEXT;
        return;
      }
      checkbox.checked = false;
      status.textContent = INVALID_TEXT;
      setRecovery("reset", "Reset to Off");
    }

    function renderReadError() {
      phase = "idle";
      pendingState = null;
      lastSnapshot = null;
      checkbox.checked = false;
      checkbox.indeterminate = true;
      checkbox.disabled = true;
      status.textContent = READ_ERROR_TEXT;
      setRecovery("read", "Retry");
    }

    function showSnapshotWithoutStatus(snapshot) {
      if (snapshot && snapshot.valid === true) {
        checkbox.indeterminate = false;
        checkbox.checked = snapshot.enabled === true;
        checkbox.disabled = false;
      } else if (snapshot) {
        checkbox.indeterminate = false;
        checkbox.checked = false;
        checkbox.disabled = false;
      } else {
        checkbox.indeterminate = true;
        checkbox.checked = false;
        checkbox.disabled = true;
      }
    }

    function renderWriteError(desired, snapshot) {
      phase = "idle";
      pendingState = null;
      failedDesired = desired;
      if (snapshot) lastSnapshot = snapshot;
      showSnapshotWithoutStatus(lastSnapshot);
      status.textContent = WRITE_ERROR_TEXT;
      setRecovery("write", "Retry");
    }

    function decodedBoolean(enabled) {
      return Object.freeze({ enabled, valid: true, kind: "boolean" });
    }

    async function load() {
      const currentOperation = operation + 1;
      operation = currentOperation;
      const readRevision = revision;
      phase = "loading";
      pendingState = null;
      checkbox.checked = false;
      checkbox.indeterminate = true;
      checkbox.disabled = true;
      status.textContent = "Loading setting…";
      hideRecovery();
      try {
        const state = await settingsApi.read();
        if (stopped || operation !== currentOperation) return;
        if (revision !== readRevision && pendingState) renderState(pendingState);
        else renderState(state);
      } catch {
        if (stopped || operation !== currentOperation) return;
        if (revision !== readRevision && pendingState) renderState(pendingState);
        else renderReadError();
      }
    }

    async function save(desired) {
      const currentOperation = operation + 1;
      operation = currentOperation;
      phase = "writing";
      pendingState = null;
      checkbox.disabled = true;
      status.textContent = "Saving…";
      hideRecovery();
      try {
        await settingsApi.write(desired);
        if (stopped || operation !== currentOperation) return;
        renderState(pendingState || decodedBoolean(desired));
      } catch {
        if (stopped || operation !== currentOperation) return;
        renderWriteError(desired, pendingState);
      }
    }

    checkbox.addEventListener("change", () => {
      if (phase !== "idle" || checkbox.disabled) return;
      save(checkbox.checked);
    });

    recovery.addEventListener("click", () => {
      if (phase !== "idle") return;
      if (recoveryMode === "read") load();
      else if (recoveryMode === "reset") save(false);
      else if (recoveryMode === "write" && typeof failedDesired === "boolean") {
        save(failedDesired);
      }
    });

    checkbox.checked = false;
    checkbox.indeterminate = true;
    checkbox.disabled = true;
    status.textContent = "Loading setting…";
    hideRecovery();

    try {
      if (!settingsApi || typeof settingsApi.read !== "function" ||
        typeof settingsApi.write !== "function" ||
        typeof settingsApi.addChangeListener !== "function") {
        throw new Error("Settings API is unavailable");
      }
      removeChangeListener = settingsApi.addChangeListener((state) => {
        if (stopped) return;
        revision += 1;
        if (phase === "idle") renderState(state);
        else pendingState = state;
      });
    } catch {
      renderReadError();
      return Object.freeze({ ready: Promise.resolve(), stop() {} });
    }

    const ready = load();

    function stop() {
      if (stopped) return;
      stopped = true;
      operation += 1;
      if (removeChangeListener) {
        try { removeChangeListener(); } catch { /* Popup is closing. */ }
        removeChangeListener = null;
      }
    }

    return Object.freeze({ ready, stop });
  });
