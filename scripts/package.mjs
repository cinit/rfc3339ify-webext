import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(projectRoot, "dist");
const contentScriptFiles = Object.freeze([
  "transform.js", "content.js", "settings.js", "bootstrap.js",
]);
const releaseFiles = Object.freeze([
  ...contentScriptFiles.map((name) => ({ name, source: path.join("src", name) })),
  { name: "popup.html", source: path.join("src", "popup.html") },
  { name: "popup.css", source: path.join("src", "popup.css") },
  { name: "popup.js", source: path.join("src", "popup.js") },
  ...[16, 32, 48, 128].map((size) => ({
    name: `icons/icon-${size}.png`,
    source: path.join("icons", `icon-${size}.png`),
  })),
]);
const prohibitedSource = Object.freeze([
  ["network API", /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/],
  ["dynamic code", /\b(?:eval|Function)\s*\(/],
  ["dynamic import", /\bimport\s*\(/],
  ["HTML replacement sink", /\b(?:innerHTML|outerHTML)\s*=/],
  ["page-world bridge", /\bpostMessage\s*\(/],
]);

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function localHeader(name, data, checksum) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 names, no data descriptor.
  header.writeUInt16LE(0, 8); // Stored without compression.
  header.writeUInt16LE(0, 10); // 00:00:00.
  header.writeUInt16LE(33, 12); // 1980-01-01.
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes]);
}

function centralHeader(name, data, checksum, offset) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBytes]);
}

function makeZip(inputEntries) {
  const entries = [...inputEntries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const checksum = crc32(entry.data);
    const local = localHeader(entry.name, entry.data, checksum);
    localParts.push(local, entry.data);
    centralParts.push(centralHeader(entry.name, entry.data, checksum, offset));
    offset += local.length + entry.data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function validateManifest(target, manifest) {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches,
    ["http://*/*", "https://*/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, contentScriptFiles);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].match_about_blank, true);
  assert.equal(manifest.content_scripts[0].match_origin_as_fallback, true);
  assert.equal(manifest.content_scripts[0].run_at, "document_idle");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.icons, {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  });
  assert.deepEqual(manifest.action, {
    default_title: "RFC3339ify controls",
    default_popup: "popup.html",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
    },
  });
  for (const forbidden of [
    "host_permissions", "background",
    "web_accessible_resources", "externally_connectable",
  ]) {
    assert.equal(Object.hasOwn(manifest, forbidden), false,
      `${target} unexpectedly declares ${forbidden}`);
  }

  if (target === "chrome") {
    assert.equal(manifest.minimum_chrome_version, "99");
    assert.equal(Object.hasOwn(manifest, "browser_specific_settings"), false);
  } else {
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
    assert.deepEqual(
      manifest.browser_specific_settings.gecko.data_collection_permissions.required,
      ["none"]);
    assert.equal(
      manifest.browser_specific_settings.gecko_android.strict_min_version,
      "142.0");
    assert.match(manifest.browser_specific_settings.gecko.id,
      /^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/);
  }
}

async function loadReleaseSources() {
  const entries = [];
  for (const file of releaseFiles) {
    const data = await readFile(path.join(projectRoot, file.source));
    if (file.name.endsWith(".js")) {
      const source = data.toString("utf8");
      for (const [capability, pattern] of prohibitedSource) {
        assert.doesNotMatch(source, pattern,
          `${file.name} contains prohibited ${capability}`);
      }
    } else if (file.name === "popup.html") {
      const source = data.toString("utf8");
      assert.doesNotMatch(source, /<script(?!\s+src=)/i,
        "popup.html contains inline script");
      assert.doesNotMatch(source, /\son[a-z]+\s*=/i,
        "popup.html contains inline event handler");
      assert.doesNotMatch(source, /https?:\/\//i,
        "popup.html contains a remote URL");
    } else if (file.name === "popup.css") {
      const source = data.toString("utf8");
      assert.match(source, /color-scheme:\s*light dark/);
      assert.doesNotMatch(source, /appearance\s*:\s*none/i);
      assert.doesNotMatch(source, /#(?:000(?:000)?|fff(?:fff)?)\b/i,
        "popup.css contains a hard-coded black/white color");
    } else if (file.name.endsWith(".png")) {
      const expectedSize = Number(file.name.match(/icon-(\d+)\.png$/)[1]);
      assert.deepEqual(data.subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(data.readUInt32BE(16), expectedSize);
      assert.equal(data.readUInt32BE(20), expectedSize);
    }
    entries.push({ name: file.name, data });
  }
  return entries;
}

async function buildTarget(target, releaseSources) {
  const manifestPath = path.join(projectRoot, "manifests", `${target}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(target, manifest);
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const entries = [{ name: "manifest.json", data: manifestData }, ...releaseSources];
  const targetDirectory = path.join(distRoot, target);
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(path.join(targetDirectory, "manifest.json"), manifestData);
  for (const entry of releaseSources) {
    const destination = path.join(targetDirectory, entry.name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
  }

  const firstZip = makeZip(entries);
  const secondZip = makeZip(entries);
  assert.deepEqual(firstZip, secondZip, `${target} ZIP generation is not deterministic`);
  await writeFile(path.join(distRoot,
    `rfc3339ify-${target}-${manifest.version}.zip`), firstZip);
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });
const releaseSources = await loadReleaseSources();
await buildTarget("chrome", releaseSources);
await buildTarget("firefox", releaseSources);
