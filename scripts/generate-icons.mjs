import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconDirectory = path.join(projectRoot, "icons");
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

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function paintPixel(pixels, dimension, x, y, color) {
  const offset = (y * dimension + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = 255;
}

function fillCircle(pixels, dimension, centerX, centerY, radius, color) {
  const radiusSquared = radius * radius;
  for (let y = 0; y < dimension; y += 1) {
    for (let x = 0; x < dimension; x += 1) {
      const dx = (x + 0.5) / dimension - centerX;
      const dy = (y + 0.5) / dimension - centerY;
      if (dx * dx + dy * dy <= radiusSquared) {
        paintPixel(pixels, dimension, x, y, color);
      }
    }
  }
}

function fillRect(pixels, dimension, left, top, right, bottom, color) {
  const startX = Math.floor(left * dimension);
  const endX = Math.ceil(right * dimension);
  const startY = Math.floor(top * dimension);
  const endY = Math.ceil(bottom * dimension);
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      if (x >= 0 && x < dimension && y >= 0 && y < dimension) {
        paintPixel(pixels, dimension, x, y, color);
      }
    }
  }
}

function makePixels(size) {
  const scale = 4;
  const dimension = size * scale;
  const highResolution = Buffer.alloc(dimension * dimension * 4);
  const blue = [48, 105, 220];
  const white = [255, 255, 255];

  fillCircle(highResolution, dimension, 0.5, 0.5, 0.47, blue);
  fillRect(highResolution, dimension, 0.22, 0.27, 0.78, 0.76, white);
  fillRect(highResolution, dimension, 0.29, 0.36, 0.71, 0.69, blue);
  fillRect(highResolution, dimension, 0.22, 0.41, 0.78, 0.47, white);
  fillRect(highResolution, dimension, 0.33, 0.20, 0.41, 0.35, white);
  fillRect(highResolution, dimension, 0.59, 0.20, 0.67, 0.35, white);
  for (const top of [0.52, 0.62]) {
    for (const left of [0.35, 0.55]) {
      fillRect(highResolution, dimension, left, top, left + 0.09, top + 0.07, white);
    }
  }

  const pixels = Buffer.alloc(size * size * 4);
  const samples = scale * scale;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blueChannel = 0;
      for (let sampleY = 0; sampleY < scale; sampleY += 1) {
        for (let sampleX = 0; sampleX < scale; sampleX += 1) {
          const source = (((y * scale + sampleY) * dimension) +
            x * scale + sampleX) * 4;
          const sampleAlpha = highResolution[source + 3];
          alpha += sampleAlpha;
          red += highResolution[source] * sampleAlpha;
          green += highResolution[source + 1] * sampleAlpha;
          blueChannel += highResolution[source + 2] * sampleAlpha;
        }
      }
      const target = (y * size + x) * 4;
      pixels[target + 3] = Math.round(alpha / samples);
      if (alpha > 0) {
        pixels[target] = Math.round(red / alpha);
        pixels[target + 1] = Math.round(green / alpha);
        pixels[target + 2] = Math.round(blueChannel / alpha);
      }
    }
  }
  return pixels;
}

function makePng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = makePixels(size);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    rows[rowOffset] = 0;
    pixels.copy(rows, rowOffset + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(iconDirectory, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(path.join(iconDirectory, `icon-${size}.png`), makePng(size));
}
