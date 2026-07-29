/*
 * Bounded DOM integration for RFC3339ify.
 *
 * In a browser this file starts itself after transform.js.  Node-based DOM
 * tests require the exported starter explicitly.
 */
(function exposeContent(globalObject, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory;
  } else {
    factory(globalObject, globalObject.RFC3339ifyTransform);
  }
})(typeof globalThis === "object" ? globalThis : this,
  function startRFC3339ify(windowObject, transformApi, options) {
    "use strict";

    options = options || {};

    const MAX_PENDING_ENTRIES_PER_ROOT = 1024;
    const MAX_PENDING_ENTRIES_PER_DOCUMENT = 8192;
    const MAX_PENDING_MUTATION_RECORDS = 8192;
    const MAX_OBSERVED_SHADOW_ROOTS = 4096;
    const MAX_COOLDOWN_NODES = 1024;
    const SMALL_NODE_PREFILTER_LIMIT = 4096;
    const MAX_ATTRIBUTE_TOKEN_LENGTH = 4096;
    const MAX_WORK_ITEMS_PER_SLICE = 256;
    const SCANNER_STEPS_PER_WORK_ITEM = 64;
    const SLICE_TARGET_MS = 2;
    const CONFLICT_WINDOW_MS = 2000;
    const ALLOWED_EXTERNAL_OVERWRITES = 4;
    const CONFLICT_COOLDOWN_MS = 10000;

    const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
    const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
    const HTML_EXCLUDED = new Set([
      "script", "style", "noscript", "template", "textarea", "select",
      "option", "datalist", "title", "head",
    ]);
    const SVG_EXCLUDED = new Set(["script", "style", "title", "desc"]);
    const EDITOR_CLASS_TOKENS = new Set([
      "monaco-editor", "CodeMirror", "cm-editor", "ace_editor",
    ]);
    const EDITOR_ROLE_TOKENS = new Set(["textbox", "searchbox", "combobox"]);
    const MONTH_INITIALS = new Set([
      "J", "j", "F", "f", "M", "m", "A", "a",
      "S", "s", "O", "o", "N", "n", "D", "d",
    ]);

    if (!windowObject || !windowObject.document || !transformApi ||
      typeof transformApi.createTransform !== "function" ||
      typeof transformApi.resumeTransform !== "function") {
      throw new TypeError("RFC3339ify content script requires a Window and transform API");
    }

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
      return Object.freeze({ active: false, stop() {}, flushForTest() { return 0; } });
    }

    const manualScheduling = options.manualScheduling === true;
    const now = typeof options.now === "function" ? options.now : () => {
      if (windowObject.performance && typeof windowObject.performance.now === "function") {
        return windowObject.performance.now();
      }
      return Date.now();
    };

    let stopped = false;
    let scheduled = false;
    let scheduleHandle = null;
    let queue = [];
    let queueHead = 0;
    let queueEpoch = 1;
    let globalPendingEntries = 0;
    let globalPendingRecords = 0;
    let globalMutationEpoch = 0;
    let shadowCleanupSweepQueued = false;
    let shadowCoverageLimited = false;
    let observedShadowRoots = 0;
    let cooldownTimer = null;
    let cooldownSweepQueued = false;

    const activeRoots = new Map();
    const activeTextTasks = new WeakMap();
    const pendingWrites = new WeakMap();
    const normalizedNodes = new WeakSet();
    const conflictHistory = new WeakMap();
    const cooldownNodes = new Map();

    function syncRootEntryEpoch(rootState) {
      if (rootState.entryEpoch !== queueEpoch) {
        rootState.entryEpoch = queueEpoch;
        rootState.pendingEntries = 0;
      }
    }

    function rawQueue(task, counted) {
      task.queueEpoch = queueEpoch;
      task.counted = counted;
      queue.push(task);
      if (counted && task.rootState) {
        syncRootEntryEpoch(task.rootState);
        task.rootState.pendingEntries += 1;
        globalPendingEntries += 1;
      }
      scheduleDrain();
    }

    function clearRootRecords(rootState) {
      if (rootState.pendingRecordCount !== 0) {
        globalPendingRecords = Math.max(0,
          globalPendingRecords - rootState.pendingRecordCount);
      }
      rootState.pendingRecordCount = 0;
      rootState.recordBatches = [];
      rootState.recordBatchIndex = 0;
      rootState.recordsTaskQueued = false;
    }

    function markRootDirty(rootState) {
      if (!rootState.active) return;
      if (rootState.dirtyQueued) {
        clearRootRecords(rootState);
        rootState.rescanAgain = true;
        return;
      }
      syncRootEntryEpoch(rootState);
      globalPendingEntries = Math.max(0,
        globalPendingEntries - rootState.pendingEntries);
      rootState.pendingEntries = 0;
      rootState.generation += 1;
      clearRootRecords(rootState);
      if (globalPendingEntries >= MAX_PENDING_ENTRIES_PER_DOCUMENT) {
        triggerGlobalRecovery();
        return;
      }
      rootState.rescanAgain = false;
      rootState.dirtyQueued = true;
      rawQueue(makeRootTraversal(rootState, "dirty"), true);
    }

    function triggerGlobalRecovery() {
      // Replacing the queue drops all stale task references in constant time.
      queue = [];
      queueHead = 0;
      queueEpoch += 1;
      globalPendingEntries = 0;
      // A previously queued sweep, if any, was discarded with the old queue.
      shadowCleanupSweepQueued = false;
      rawQueue({
        kind: "global-recovery",
        iterator: activeRoots.values(),
        rootState: null,
      }, false);
    }

    function enqueueTask(rootState, task) {
      if (stopped || !rootState || !rootState.active) return false;
      syncRootEntryEpoch(rootState);
      if (rootState.pendingEntries >= MAX_PENDING_ENTRIES_PER_ROOT) {
        markRootDirty(rootState);
        return false;
      }
      if (globalPendingEntries >= MAX_PENDING_ENTRIES_PER_DOCUMENT) {
        triggerGlobalRecovery();
        return false;
      }
      task.rootState = rootState;
      task.generation = rootState.generation;
      rawQueue(task, true);
      return true;
    }

    function takeTask() {
      if (queueHead >= queue.length) {
        queue = [];
        queueHead = 0;
        return null;
      }
      const task = queue[queueHead];
      queue[queueHead] = null;
      queueHead += 1;
      if (task.counted && task.rootState && task.queueEpoch === queueEpoch &&
        task.generation === task.rootState.generation) {
        syncRootEntryEpoch(task.rootState);
        task.rootState.pendingEntries = Math.max(0,
          task.rootState.pendingEntries - 1);
        globalPendingEntries = Math.max(0, globalPendingEntries - 1);
      }
      return task;
    }

    function hasQueuedWork() {
      return queueHead < queue.length;
    }

    function scheduleDrain() {
      if (manualScheduling || stopped || scheduled) return;
      scheduled = true;
      if (typeof windowObject.requestIdleCallback === "function") {
        scheduleHandle = windowObject.requestIdleCallback(runScheduledDrain, { timeout: 100 });
      } else {
        scheduleHandle = windowObject.setTimeout(runScheduledDrain, 0);
      }
    }

    function runScheduledDrain() {
      scheduled = false;
      scheduleHandle = null;
      drainSlice(MAX_WORK_ITEMS_PER_SLICE, SLICE_TARGET_MS);
      if (hasQueuedWork()) scheduleDrain();
    }

    function requeueContinuation(task) {
      if (task.rootState) {
        enqueueTask(task.rootState, task);
      } else {
        rawQueue(task, false);
      }
    }

    function drainSlice(maxItems, maxMilliseconds) {
      const started = now();
      let workItems = 0;
      while (!stopped && workItems < maxItems && hasQueuedWork()) {
        if (workItems > 0 && now() - started >= maxMilliseconds) break;
        const task = takeTask();
        if (!task) break;
        if (task.queueEpoch !== queueEpoch ||
          (task.rootState && (!task.rootState.active ||
            task.generation !== task.rootState.generation))) {
          workItems += 1;
          continue;
        }
        const complete = runTaskStep(task);
        if (!complete) requeueContinuation(task);
        workItems += 1;
      }
      return workItems;
    }

    function elementIsIntrinsicallyExcluded(element) {
      if (element.namespaceURI === HTML_NAMESPACE) {
        return HTML_EXCLUDED.has(element.localName);
      }
      if (element.namespaceURI === SVG_NAMESPACE) {
        return SVG_EXCLUDED.has(element.localName);
      }
      return false;
    }

    function hasWhitespaceToken(value, desiredTokens, asciiCaseInsensitive = false) {
      if (value.length > MAX_ATTRIBUTE_TOKEN_LENGTH) return true;
      let index = 0;
      while (index < value.length) {
        while (index < value.length && isAsciiWhitespace(value.charCodeAt(index))) index += 1;
        const start = index;
        while (index < value.length && !isAsciiWhitespace(value.charCodeAt(index))) index += 1;
        if (index > start) {
          let token = value.slice(start, index);
          if (asciiCaseInsensitive) token = token.toLowerCase();
          if (desiredTokens.has(token)) return true;
        }
      }
      return false;
    }

    function isAsciiWhitespace(code) {
      return code === 0x09 || code === 0x0a || code === 0x0c ||
        code === 0x0d || code === 0x20;
    }

    function elementHasEditorMarker(element) {
      const role = element.getAttribute && element.getAttribute("role");
      if (role !== null && hasWhitespaceToken(role, EDITOR_ROLE_TOKENS, true)) return true;
      const classValue = element.getAttribute && element.getAttribute("class");
      return classValue !== null && hasWhitespaceToken(classValue, EDITOR_CLASS_TOKENS);
    }

    function shouldPruneTraversal(element) {
      return elementIsIntrinsicallyExcluded(element) ||
        elementHasEditorMarker(element);
    }

    function composedParentElement(node) {
      const parent = node.parentNode;
      if (!parent) return null;
      if (parent.nodeType === 1) return parent;
      if (parent.nodeType === 11 && parent.host && parent.host.nodeType === 1) {
        return parent.host;
      }
      return null;
    }

    function isBodyElement(element) {
      return element.namespaceURI === HTML_NAMESPACE && element.localName === "body";
    }

    function makeRootTraversal(rootState, reason, startNode) {
      let firstNode;
      let oneRoot = false;
      if (startNode) {
        firstNode = startNode;
        oneRoot = true;
      } else if (rootState.root.nodeType === 9) {
        firstNode = rootState.root.documentElement;
        oneRoot = true;
      } else {
        firstNode = rootState.root.firstChild;
      }
      return {
        kind: "traverse",
        rootState,
        generation: rootState.generation,
        reason,
        frames: [{ next: firstNode, oneRoot }],
      };
    }

    function discoverShadowRoot(element) {
      let shadowRoot;
      try {
        shadowRoot = element.shadowRoot;
      } catch {
        return null;
      }
      if (!shadowRoot || activeRoots.has(shadowRoot)) return activeRoots.get(shadowRoot) || null;
      if (observedShadowRoots >= MAX_OBSERVED_SHADOW_ROOTS) {
        shadowCoverageLimited = true;
        return null;
      }
      return enrollRoot(shadowRoot, element);
    }

    function stepTraversal(task) {
      if (task.frames.length === 0) {
        if (task.reason === "dirty") {
          task.rootState.dirtyQueued = false;
          if (task.rootState.rescanAgain) {
            task.rootState.rescanAgain = false;
            markRootDirty(task.rootState);
          }
        }
        return true;
      }

      const frame = task.frames[task.frames.length - 1];
      if (!frame.next) {
        task.frames.pop();
        return task.frames.length === 0;
      }

      const node = frame.next;
      frame.next = frame.oneRoot ? null : node.nextSibling;
      if (node.nodeType === 1) {
        const excluded = shouldPruneTraversal(node);
        if (!excluded) {
          const shadowState = discoverShadowRoot(node);
          if (task.reason === "eligibility" && shadowState) {
            enqueueTask(shadowState, makeRootTraversal(shadowState, "eligibility"));
          }
          if (node.firstChild) task.frames.push({ next: node.firstChild, oneRoot: false });
        }
      } else if (node.nodeType === 3) {
        enqueueTextNode(task.rootState, node, false);
      }
      return false;
    }

    function likelyContainsCandidate(input) {
      let hasMonthInitial = false;
      let hasColon = false;
      let hasMeridiemInitial = false;
      for (let index = 0; index < input.length; index += 1) {
        const value = input[index];
        if (MONTH_INITIALS.has(value)) hasMonthInitial = true;
        if (value === ":") hasColon = true;
        if (value === "A" || value === "a" || value === "P" || value === "p") {
          hasMeridiemInitial = true;
        }
      }
      return hasMonthInitial || (hasColon && hasMeridiemInitial);
    }

    function resetTextEligibility(task) {
      task.phase = "eligibility-start";
      task.ancestor = null;
      task.foundBody = false;
      task.contentEditableResolved = false;
      task.input = null;
      task.transformState = null;
      task.output = null;
      task.eligibilityEpoch = globalMutationEpoch;
    }

    function finishTextTask(task) {
      if (activeTextTasks.get(task.node) === task) activeTextTasks.delete(task.node);
      return true;
    }

    function rejectTextTask(task) {
      return finishTextTask(task);
    }

    function stepTextEligibility(task) {
      const node = task.node;
      if (task.phase === "eligibility-start") {
        if (!node.isConnected || node.ownerDocument !== documentObject ||
          String(documentObject.designMode).toLowerCase() === "on") {
          return rejectTextTask(task);
        }
        task.ancestor = composedParentElement(node);
        task.phase = "eligibility-walk";
        return false;
      }

      if (task.ancestor) {
        const element = task.ancestor;
        if (element.ownerDocument !== documentObject ||
          elementIsIntrinsicallyExcluded(element) || elementHasEditorMarker(element) ||
          (!task.contentEditableResolved && element.isContentEditable === true)) {
          return rejectTextTask(task);
        }
        if (isBodyElement(element)) task.foundBody = true;

        if (!task.contentEditableResolved && element.hasAttribute("contenteditable")) {
          const raw = element.getAttribute("contenteditable");
          if (raw.length > MAX_ATTRIBUTE_TOKEN_LENGTH) return rejectTextTask(task);
          const value = raw.trim().toLowerCase();
          if (value === "false") {
            task.contentEditableResolved = true;
          } else if (value === "" || value === "true" || value === "plaintext-only") {
            return rejectTextTask(task);
          }
        }

        task.ancestor = composedParentElement(element);
        return false;
      }

      if (!task.foundBody) return rejectTextTask(task);
      task.input = node.data;
      if (task.input.length <= SMALL_NODE_PREFILTER_LIMIT &&
        !likelyContainsCandidate(task.input)) {
        return finishTextTask(task);
      }
      task.transformState = transformApi.createTransform(task.input);
      task.eligibilityEpoch = globalMutationEpoch;
      task.phase = "scan";
      return false;
    }

    function currentRootStateForNode(node) {
      let root;
      try {
        root = node.getRootNode();
      } catch {
        return null;
      }
      return activeRoots.get(root) || null;
    }

    function resetForCurrentText(task) {
      const rootState = currentRootStateForNode(task.node);
      if (!rootState || !rootState.active) return finishTextTask(task);
      task.rootState = rootState;
      task.generation = rootState.generation;
      task.external = true;
      resetTextEligibility(task);
      return false;
    }

    function recordExternalRewrite(node, currentTime) {
      const cooldown = cooldownNodes.get(node);
      if (cooldown && cooldown.deadline > currentTime) return false;
      if (cooldown) cooldownNodes.delete(node);

      let history = conflictHistory.get(node);
      if (!history) history = [];
      let firstRecent = 0;
      while (firstRecent < history.length &&
        history[firstRecent] <= currentTime - CONFLICT_WINDOW_MS) {
        firstRecent += 1;
      }
      if (firstRecent > 0) history = history.slice(firstRecent);
      if (history.length >= ALLOWED_EXTERNAL_OVERWRITES) {
        conflictHistory.delete(node);
        if (cooldownNodes.size < MAX_COOLDOWN_NODES) {
          const deadline = currentTime + CONFLICT_COOLDOWN_MS;
          cooldownNodes.set(node, { deadline });
          scheduleCooldownTimer(deadline);
        }
        return false;
      }
      history.push(currentTime);
      conflictHistory.set(node, history);
      return true;
    }

    function stepTextTask(task) {
      if (task.phase === "eligibility-start" || task.phase === "eligibility-walk") {
        return stepTextEligibility(task);
      }

      if (task.phase === "scan") {
        if (task.node.data !== task.input) return resetForCurrentText(task);
        const result = transformApi.resumeTransform(
          task.transformState, SCANNER_STEPS_PER_WORK_ITEM);
        if (result.status !== "done") return false;
        task.output = result.value;
        task.phase = "write";
        return false;
      }

      if (task.node.data !== task.input) return resetForCurrentText(task);
      if (task.eligibilityEpoch !== globalMutationEpoch) {
        // Any delivered mutation may have changed a composed editable ancestor.
        // Revalidation is bounded and avoids a stale eligibility decision.
        resetTextEligibility(task);
        return false;
      }
      if (task.output === task.input) return finishTextTask(task);

      if (task.external && normalizedNodes.has(task.node) &&
        !recordExternalRewrite(task.node, now())) {
        return finishTextTask(task);
      }

      pendingWrites.set(task.node, task.output);
      normalizedNodes.add(task.node);
      task.node.data = task.output;
      return finishTextTask(task);
    }

    function enqueueTextNode(rootState, node, external) {
      if (!node || node.nodeType !== 3 || !rootState.active) return;
      if (!external && pendingWrites.has(node) &&
        node.data === pendingWrites.get(node)) {
        pendingWrites.delete(node);
      }
      let existing = activeTextTasks.get(node);
      if (existing && (existing.queueEpoch !== queueEpoch ||
        existing.rootState.generation !== existing.generation)) {
        activeTextTasks.delete(node);
        existing = null;
      }
      if (existing) {
        if (external) existing.external = true;
        return;
      }
      const task = {
        kind: "text",
        rootState,
        node,
        external,
      };
      resetTextEligibility(task);
      activeTextTasks.set(node, task);
      if (!enqueueTask(rootState, task)) activeTextTasks.delete(node);
    }

    function stepMutationNodes(task) {
      const record = task.record;
      if (task.addedIndex < record.addedNodes.length) {
        const node = record.addedNodes[task.addedIndex];
        task.addedIndex += 1;
        if (node.nodeType === 3) enqueueTextNode(task.rootState, node, true);
        else if (node.nodeType === 1) {
          enqueueTask(task.rootState,
            makeRootTraversal(task.rootState, "mutation", node));
        }
        return false;
      }
      if (task.removedIndex < record.removedNodes.length) {
        const node = record.removedNodes[task.removedIndex];
        task.removedIndex += 1;
        if (node.nodeType === 1 || node.nodeType === 3) {
          enqueueTask(task.rootState, makeCleanupTask(task.rootState, node));
        }
        return false;
      }
      task.record = null;
      return true;
    }

    function processMutationRecord(rootState, record) {
      if (record.type === "characterData") {
        const node = record.target;
        if (pendingWrites.has(node)) {
          const expected = pendingWrites.get(node);
          pendingWrites.delete(node);
          if (node.data === expected) return;
        }
        enqueueTextNode(rootState, node, true);
      } else if (record.type === "childList") {
        enqueueTask(rootState, {
          kind: "mutation-nodes",
          rootState,
          record,
          addedIndex: 0,
          removedIndex: 0,
        });
      } else if (record.type === "attributes") {
        enqueueTask(rootState,
          makeRootTraversal(rootState, "eligibility", record.target));
      }
    }

    function stepRecordProcessor(task) {
      const rootState = task.rootState;
      if (rootState.recordBatchIndex < rootState.recordBatches.length &&
        rootState.recordBatches[rootState.recordBatchIndex] === null) {
        rootState.recordBatchIndex += 1;
        return false;
      }
      if (rootState.recordBatchIndex >= rootState.recordBatches.length) {
        rootState.recordBatches = [];
        rootState.recordBatchIndex = 0;
        rootState.recordsTaskQueued = false;
        return true;
      }

      const batch = rootState.recordBatches[rootState.recordBatchIndex];
      if (batch.index >= batch.records.length) {
        rootState.recordBatches[rootState.recordBatchIndex] = null;
        rootState.recordBatchIndex += 1;
        return false;
      }
      const record = batch.records[batch.index];
      batch.index += 1;
      rootState.pendingRecordCount -= 1;
      globalPendingRecords = Math.max(0, globalPendingRecords - 1);
      processMutationRecord(rootState, record);
      return false;
    }

    function makeCleanupTask(rootState, node) {
      return {
        kind: "cleanup",
        rootState,
        frames: [{ next: node, oneRoot: true }],
      };
    }

    function disconnectRoot(rootState) {
      if (!rootState || !rootState.active || rootState.root === documentObject) return;
      rootState.active = false;
      rootState.observer.disconnect();
      rootState.generation += 1;
      syncRootEntryEpoch(rootState);
      globalPendingEntries = Math.max(0,
        globalPendingEntries - rootState.pendingEntries);
      rootState.pendingEntries = 0;
      clearRootRecords(rootState);
      activeRoots.delete(rootState.root);
      observedShadowRoots = Math.max(0, observedShadowRoots - 1);
      if (shadowCoverageLimited) {
        shadowCoverageLimited = false;
        markRootDirty(activeRoots.get(documentObject));
      }
    }

    function stepCleanup(task) {
      if (task.frames.length === 0) return true;
      const frame = task.frames[task.frames.length - 1];
      if (!frame.next) {
        task.frames.pop();
        return task.frames.length === 0;
      }
      const node = frame.next;
      frame.next = frame.oneRoot ? null : node.nextSibling;
      if (node.nodeType === 3) {
        if (!node.isConnected) {
          cooldownNodes.delete(node);
          conflictHistory.delete(node);
          pendingWrites.delete(node);
          normalizedNodes.delete(node);
          activeTextTasks.delete(node);
        }
      } else if (node.nodeType === 1) {
        let shadowRoot = null;
        try { shadowRoot = node.shadowRoot; } catch { shadowRoot = null; }
        if (node.firstChild) task.frames.push({ next: node.firstChild, oneRoot: false });
        if (shadowRoot && activeRoots.has(shadowRoot)) {
          if (shadowRoot.firstChild) {
            task.frames.push({ next: shadowRoot.firstChild, oneRoot: false });
          }
          if (!node.isConnected) disconnectRoot(activeRoots.get(shadowRoot));
        }
      }
      return false;
    }

    function queueShadowCleanupSweep() {
      if (shadowCleanupSweepQueued || stopped) return;
      shadowCleanupSweepQueued = true;
      rawQueue({
        kind: "shadow-sweep",
        iterator: activeRoots.values(),
        rootState: null,
      }, false);
    }

    function stepShadowSweep(task) {
      const next = task.iterator.next();
      if (next.done) {
        shadowCleanupSweepQueued = false;
        return true;
      }
      const rootState = next.value;
      if (rootState.host && !rootState.host.isConnected) disconnectRoot(rootState);
      return false;
    }

    function stepGlobalRecovery(task) {
      const next = task.iterator.next();
      if (next.done) {
        queueShadowCleanupSweep();
        return true;
      }
      // The queue replacement discarded any older dirty marker.
      next.value.dirtyQueued = false;
      next.value.rescanAgain = false;
      markRootDirty(next.value);
      return false;
    }

    function scheduleCooldownTimer(deadline) {
      if (manualScheduling || stopped || cooldownSweepQueued) return;
      if (cooldownTimer !== null) {
        if (cooldownTimer.deadline <= deadline) return;
        windowObject.clearTimeout(cooldownTimer.handle);
      }
      const delay = Math.max(0, Math.min(0x7fffffff, deadline - now()));
      const handle = windowObject.setTimeout(() => {
        cooldownTimer = null;
        cooldownSweepQueued = true;
        rawQueue({
          kind: "cooldown-sweep",
          iterator: cooldownNodes.entries(),
          nextDeadline: Infinity,
          rootState: null,
        }, false);
      }, delay);
      cooldownTimer = { handle, deadline };
    }

    function stepCooldownSweep(task) {
      const next = task.iterator.next();
      if (!next.done) {
        const [node, entry] = next.value;
        if (!node.isConnected) {
          cooldownNodes.delete(node);
          conflictHistory.delete(node);
        } else if (entry.deadline <= now()) {
          cooldownNodes.delete(node);
          conflictHistory.delete(node);
          const rootState = currentRootStateForNode(node);
          if (rootState) enqueueTextNode(rootState, node, false);
        } else {
          task.nextDeadline = Math.min(task.nextDeadline, entry.deadline);
        }
        return false;
      }
      cooldownSweepQueued = false;
      if (task.nextDeadline !== Infinity) scheduleCooldownTimer(task.nextDeadline);
      return true;
    }

    function runTaskStep(task) {
      switch (task.kind) {
        case "traverse": return stepTraversal(task);
        case "text": return stepTextTask(task);
        case "records": return stepRecordProcessor(task);
        case "mutation-nodes": return stepMutationNodes(task);
        case "cleanup": return stepCleanup(task);
        case "shadow-sweep": return stepShadowSweep(task);
        case "global-recovery": return stepGlobalRecovery(task);
        case "cooldown-sweep": return stepCooldownSweep(task);
        default: return true;
      }
    }

    function observerCallback(rootState, records) {
      if (stopped || records.length === 0 || !rootState.active) return;
      globalMutationEpoch += 1;
      if (records.length > MAX_PENDING_MUTATION_RECORDS - globalPendingRecords) {
        markRootDirty(rootState);
        queueShadowCleanupSweep();
        return;
      }
      rootState.recordBatches.push({ records, index: 0 });
      rootState.pendingRecordCount += records.length;
      globalPendingRecords += records.length;
      if (!rootState.recordsTaskQueued) {
        rootState.recordsTaskQueued = true;
        enqueueTask(rootState, { kind: "records", rootState });
      }
    }

    function enrollRoot(root, host) {
      const rootState = {
        root,
        host: host || null,
        active: true,
        observer: null,
        generation: 1,
        entryEpoch: queueEpoch,
        pendingEntries: 0,
        recordBatches: [],
        recordBatchIndex: 0,
        pendingRecordCount: 0,
        recordsTaskQueued: false,
        dirtyQueued: false,
        rescanAgain: false,
      };
      const observer = new windowObject.MutationObserver(
        (records) => observerCallback(rootState, records));
      rootState.observer = observer;
      activeRoots.set(root, rootState);
      if (host) observedShadowRoots += 1;
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["contenteditable", "role"],
      });
      enqueueTask(rootState, makeRootTraversal(rootState, "initial"));
      return rootState;
    }

    function flushForTest(maxWorkItems = 1_000_000) {
      if (!Number.isSafeInteger(maxWorkItems) || maxWorkItems <= 0) {
        throw new RangeError("maxWorkItems must be a positive safe integer");
      }
      let consumed = 0;
      while (hasQueuedWork() && consumed < maxWorkItems) {
        consumed += drainSlice(
          Math.min(MAX_WORK_ITEMS_PER_SLICE, maxWorkItems - consumed), Infinity);
      }
      return consumed;
    }

    function retryCooldownsForTest() {
      if (!manualScheduling) {
        throw new Error("retryCooldownsForTest requires manual scheduling");
      }
      if (cooldownSweepQueued) return;
      cooldownSweepQueued = true;
      rawQueue({
        kind: "cooldown-sweep",
        iterator: cooldownNodes.entries(),
        nextDeadline: Infinity,
        rootState: null,
      }, false);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      for (const rootState of activeRoots.values()) rootState.observer.disconnect();
      activeRoots.clear();
      queue = [];
      queueHead = 0;
      cooldownNodes.clear();
      if (scheduleHandle !== null) {
        if (typeof windowObject.cancelIdleCallback === "function") {
          windowObject.cancelIdleCallback(scheduleHandle);
        } else {
          windowObject.clearTimeout(scheduleHandle);
        }
      }
      if (cooldownTimer !== null) windowObject.clearTimeout(cooldownTimer.handle);
    }

    enrollRoot(documentObject, null);

    return Object.freeze({
      active: true,
      flushForTest,
      retryCooldownsForTest,
      stop,
      getStats() {
        return Object.freeze({
          pendingEntries: globalPendingEntries,
          pendingMutationRecords: globalPendingRecords,
          observedShadowRoots,
          shadowCoverageLimited,
          cooldownNodes: cooldownNodes.size,
        });
      },
    });
  });
