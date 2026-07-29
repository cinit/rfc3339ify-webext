"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const transformApi = require("../src/transform.js");
const startContentScript = require("../src/content.js");

function makeDom(markup, options = {}) {
  return new JSDOM(markup, {
    url: options.url || "https://example.test/page",
    contentType: options.contentType || "text/html",
    pretendToBeVisual: true,
  });
}

function start(dom, options = {}) {
  return startContentScript(dom.window, transformApi, {
    manualScheduling: true,
    ...options,
  });
}

async function deliverMutations() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("initial traversal transforms eligible text and preserves DOM identity", () => {
  const dom = makeDom(`<!doctype html>
    <html><head><title>Jan 1</title><style>.x{content:"Jan 1"}</style></head>
    <body>
      <p id="ordinary" title="Jan 1">Jan 1, 1990 at 01:00 PM</p>
      <pre id="pre">Feb 2</pre><code id="code">Mar 3</code>
      <div aria-live="polite" id="live">Apr 4</div>
      <select><option>May 5</option></select><datalist><option>Jun 6</option></datalist>
      <textarea>Jul 7</textarea>
      <div contenteditable="true">Aug 8</div>
      <div contenteditable="true"><span id="editable-false" contenteditable="false">Aug 9</span></div>
      <div role="textbox">Sep 9</div>
      <div role="SEARCHBOX">Sep 10</div>
      <div class="monaco-editor">Oct 10</div>
      <div class="CodeMirror">Nov 11</div>
      <div class="cm-editor">Dec 12</div>
      <div class="ace_editor">Jan 13</div>
      <span id="split"><b>Jan</b> 1, 1990</span>
      <svg xmlns="http://www.w3.org/2000/svg">
        <text id="svg-text">Feb 14</text><desc id="svg-desc">Mar 15</desc>
      </svg>
    </body></html>`);
  const document = dom.window.document;
  const ordinary = document.querySelector("#ordinary");
  const ordinaryText = ordinary.firstChild;
  const controller = start(dom);
  controller.flushForTest();

  assert.equal(controller.getStats().conflictRatePerSecond, 1000);
  assert.equal(controller.getStats().conflictBurst, 1000);

  assert.strictEqual(document.querySelector("#ordinary"), ordinary);
  assert.strictEqual(ordinary.firstChild, ordinaryText);
  assert.equal(ordinary.textContent, "1990-01-01 at 13:00");
  assert.equal(ordinary.getAttribute("title"), "Jan 1");
  assert.equal(document.title, "Jan 1");
  assert.equal(document.querySelector("#pre").textContent, "02-02");
  assert.equal(document.querySelector("#code").textContent, "03-03");
  assert.equal(document.querySelector("#live").textContent, "04-04");
  assert.equal(document.querySelector("#editable-false").textContent, "08-09");
  for (const selector of [
    "select option", "datalist option", "textarea", "[contenteditable]",
    "[role=textbox]", "[role=SEARCHBOX]", ".monaco-editor", ".CodeMirror", ".cm-editor", ".ace_editor",
  ]) {
    assert.match(document.querySelector(selector).textContent,
      /(?:May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jan) \d+/);
  }
  assert.equal(document.querySelector("#split").textContent, "Jan 1, 1990");
  assert.equal(document.querySelector("#svg-text").textContent, "02-14");
  assert.equal(document.querySelector("#svg-desc").textContent, "Mar 15");

  controller.stop();
  dom.window.close();
});

test("plain-text MIME and non-HTTP top-level documents fail closed", () => {
  const plainDom = makeDom("<!doctype html><body><pre>Jan 1</pre></body>");
  Object.defineProperty(plainDom.window.document, "contentType", {
    configurable: true,
    value: "text/plain",
  });
  const plainController = start(plainDom);
  assert.equal(plainController.active, false);
  assert.equal(plainDom.window.document.body.textContent, "Jan 1");

  const dataDom = makeDom("<!doctype html><body>Jan 1</body>", {
    url: "data:text/html,Jan%201",
  });
  const dataController = start(dataDom);
  assert.equal(dataController.active, false);
  assert.equal(dataDom.window.document.body.textContent, "Jan 1");

  plainDom.window.close();
  dataDom.window.close();
});

test("XHTML and mixed namespaces use exact namespace-aware exclusions", () => {
  const dom = makeDom(`<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml">
      <head><title>Jan 1</title></head>
      <body>
        <p id="xhtml">Feb 2</p>
        <svg xmlns="http://www.w3.org/2000/svg"><text id="svg">Mar 3</text><desc id="desc">Apr 4</desc></svg>
        <other xmlns="urn:example"><title id="foreign">May 5</title></other>
      </body>
    </html>`, { contentType: "application/xhtml+xml" });
  const controller = start(dom);
  controller.flushForTest();
  const document = dom.window.document;
  assert.equal(document.getElementById("xhtml").textContent, "02-02");
  assert.equal(document.getElementById("svg").textContent, "03-03");
  assert.equal(document.getElementById("desc").textContent, "Apr 4");
  assert.equal(document.getElementById("foreign").textContent, "05-05");
  assert.equal(document.querySelector("head title").textContent, "Jan 1");
  controller.stop();
  dom.window.close();
});

test("open shadow roots and composed ancestor exclusions are handled", () => {
  const dom = makeDom(`<!doctype html><body>
    <div id="host"></div>
    <div id="editable" contenteditable="true"><div id="blocked-host"></div></div>
    <div id="outer"></div>
  </body>`);
  const document = dom.window.document;
  const host = document.querySelector("#host");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<span id='shadow-text'>Jan 1</span>";
  const blockedHost = document.querySelector("#blocked-host");
  blockedHost.attachShadow({ mode: "open" }).innerHTML = "<span>Feb 2</span>";
  const outer = document.querySelector("#outer");
  const outerShadow = outer.attachShadow({ mode: "open" });
  const innerHost = document.createElement("span");
  outerShadow.append(innerHost);
  innerHost.attachShadow({ mode: "open" }).innerHTML = "<span id='nested'>Mar 3</span>";

  const controller = start(dom);
  controller.flushForTest();
  assert.equal(shadow.querySelector("#shadow-text").textContent, "01-01");
  assert.equal(blockedHost.shadowRoot.textContent, "Feb 2");
  assert.equal(innerHost.shadowRoot.querySelector("#nested").textContent, "03-03");
  assert.equal(controller.getStats().observedShadowRoots, 4);

  controller.stop();
  dom.window.close();
});

test("dynamic additions, character changes, and eligibility transitions converge", async () => {
  const dom = makeDom(`<!doctype html><body>
    <p id="changing">Jan 1</p>
    <div id="editable" contenteditable="true"><span>Feb 2</span></div>
    <div id="shadow-host" role="textbox"></div>
  </body>`);
  const document = dom.window.document;
  const shadowHost = document.querySelector("#shadow-host");
  shadowHost.attachShadow({ mode: "open" }).innerHTML = "<span>Mar 3</span>";
  const controller = start(dom);
  controller.flushForTest();
  assert.equal(document.querySelector("#changing").textContent, "01-01");
  assert.equal(document.querySelector("#editable").textContent, "Feb 2");
  assert.equal(shadowHost.shadowRoot.textContent, "Mar 3");

  const added = document.createElement("p");
  added.textContent = "Apr 4 at 04:00 PM";
  document.body.append(added);
  document.querySelector("#changing").firstChild.data = "May 5";
  document.querySelector("#editable").setAttribute("contenteditable", "false");
  shadowHost.removeAttribute("role");
  await deliverMutations();
  controller.flushForTest();

  assert.equal(added.textContent, "04-04 at 16:00");
  assert.equal(document.querySelector("#changing").textContent, "05-05");
  assert.equal(document.querySelector("#editable").textContent, "02-02");
  assert.equal(shadowHost.shadowRoot.textContent, "03-03");

  // Entering an editable region prevents future writes but does not undo an
  // earlier normalization.
  document.querySelector("#changing").setAttribute("contenteditable", "true");
  document.querySelector("#changing").firstChild.data = "Jun 6";
  await deliverMutations();
  controller.flushForTest();
  assert.equal(document.querySelector("#changing").textContent, "Jun 6");

  controller.stop();
  dom.window.close();
});

test("extension writes do not loop and adversarial overwrites enter cooldown", async () => {
  let clock = 100;
  const dom = makeDom(`<!doctype html><body>
    <p id="value">Jan 1</p><p id="other">Feb 2</p>
  </body>`);
  const node = dom.window.document.querySelector("#value").firstChild;
  const otherNode = dom.window.document.querySelector("#other").firstChild;
  const controller = start(dom, {
    now: () => clock,
    conflictRatePerSecond: 4,
    conflictBurst: 4,
  });
  controller.flushForTest();
  assert.equal(node.data, "01-01");

  // Deliver and classify the extension's own mutation record.
  await deliverMutations();
  controller.flushForTest();
  assert.equal(controller.getStats().cooldownNodes, 0);

  for (let overwrite = 0; overwrite < 4; overwrite += 1) {
    node.data = "Jan 1";
    await deliverMutations();
    controller.flushForTest();
    assert.equal(node.data, "01-01", `allowed overwrite ${overwrite + 1}`);
  }
  node.data = "Jan 1";
  await deliverMutations();
  controller.flushForTest();
  assert.equal(node.data, "Jan 1");
  assert.equal(controller.getStats().cooldownNodes, 1);

  otherNode.data = "Mar 3";
  await deliverMutations();
  controller.flushForTest();
  assert.equal(otherNode.data, "03-03", "another node has an independent bucket");

  clock += 10_001;
  controller.retryCooldownsForTest();
  controller.flushForTest();
  assert.equal(node.data, "01-01");
  assert.equal(controller.getStats().cooldownNodes, 0);

  controller.stop();
  dom.window.close();
});

test("removed shadow roots are cleaned up and may be re-enrolled", async () => {
  const dom = makeDom("<!doctype html><body><div id='host'></div></body>");
  const document = dom.window.document;
  const host = document.querySelector("#host");
  host.attachShadow({ mode: "open" }).innerHTML = "<span>Jan 1</span>";
  const controller = start(dom);
  controller.flushForTest();
  assert.equal(controller.getStats().observedShadowRoots, 1);

  host.remove();
  await deliverMutations();
  controller.flushForTest();
  assert.equal(controller.getStats().observedShadowRoots, 0);

  document.body.append(host);
  await deliverMutations();
  controller.flushForTest();
  assert.equal(controller.getStats().observedShadowRoots, 1);

  controller.stop();
  dom.window.close();
});

test("large text nodes are processed through bounded resumable work", () => {
  const padding = "x".repeat(100_000);
  const dom = makeDom(`<!doctype html><body><p>${padding} Jan 1</p></body>`);
  const controller = start(dom);
  const node = dom.window.document.querySelector("p").firstChild;
  assert.equal(controller.flushForTest(10), 10);
  assert.equal(node.data.endsWith("Jan 1"), true);
  let total = 10;
  while (controller.getStats().pendingEntries > 0 && total < 20_000) {
    total += controller.flushForTest(128);
  }
  assert.equal(node.data.endsWith("01-01"), true);
  assert.ok(total > 1000, "large scan should yield many times");
  controller.stop();
  dom.window.close();
});

test("the open-shadow-root cap fails closed and freed capacity triggers discovery", async () => {
  const dom = makeDom("<!doctype html><body></body>");
  const document = dom.window.document;
  const hosts = [];
  for (let index = 0; index < 4097; index += 1) {
    const host = document.createElement("span");
    host.attachShadow({ mode: "open" }).textContent = "Jan 1";
    hosts.push(host);
    document.body.append(host);
  }
  const controller = start(dom);
  controller.flushForTest(1_000_000);
  assert.equal(controller.getStats().observedShadowRoots, 4096);
  assert.equal(controller.getStats().shadowCoverageLimited, true);
  assert.equal(hosts[4096].shadowRoot.textContent, "Jan 1");

  hosts[0].remove();
  await deliverMutations();
  controller.flushForTest(1_000_000);
  assert.equal(controller.getStats().observedShadowRoots, 4096);
  assert.equal(hosts[4096].shadowRoot.textContent, "01-01");

  controller.stop();
  dom.window.close();
});

test("oversized mutation deliveries take bounded dirty-root recovery", async () => {
  const dom = makeDom("<!doctype html><body><p>x</p></body>");
  const node = dom.window.document.querySelector("p").firstChild;
  const controller = start(dom);
  controller.flushForTest();

  for (let burst = 0; burst < 3; burst += 1) {
    for (let index = 0; index < 8200; index += 1) {
      node.data = index === 8199 ? "Jan 1" : `value ${burst}-${index}`;
    }
    await deliverMutations();
  }
  // The callback retains no oversized record batch. Recovery is represented
  // by a bounded dirty-root marker and converges from current DOM state.
  assert.equal(controller.getStats().pendingMutationRecords, 0);
  assert.ok(controller.getStats().pendingEntries <= 1);
  controller.flushForTest();
  assert.equal(node.data, "01-01");
  assert.equal(controller.getStats().pendingMutationRecords, 0);

  controller.stop();
  dom.window.close();
});
