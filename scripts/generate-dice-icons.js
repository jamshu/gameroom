import fs from 'fs';
import zlib from 'zlib';

function writePNG(path, size) {
  const width = size;
  const height = size;
  const rgba = new Uint8Array(width * height * 4);

  const setPixel = (x, y, color) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = color[0];
    rgba[i + 1] = color[1];
    rgba[i + 2] = color[2];
    rgba[i + 3] = color[3];
  };

  const fillRect = (x0, y0, x1, y1, color) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
        setPixel(x, y, color);
      }
    }
  };

  const drawCircle = (cx, cy, r, color) => {
    const r2 = r * r;
    const x0 = Math.floor(cx - r);
    const x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) setPixel(x, y, color);
      }
    }
  };

  const drawRoundedRect = (cx, cy, w, h, r, color) => {
    const x0 = Math.round(cx - w / 2);
    const x1 = Math.round(cx + w / 2);
    const y0 = Math.round(cy - h / 2);
    const y1 = Math.round(cy + h / 2);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const dx = Math.max(x0 + r - x, 0, x - (x1 - r - 1));
        const dy = Math.max(y0 + r - y, 0, y - (y1 - r - 1));
        if (dx * dx + dy * dy <= r * r) {
          setPixel(x, y, color);
        }
      }
    }
  };

  const draw = () => {
    fillRect(0, 0, width, height, [124, 58, 237, 255]);

    const outer = Math.round(width * 0.84);
    const inner = Math.round(width * 0.7);
    const radius = Math.round(width * 0.14);
    drawRoundedRect(width / 2, width / 2, outer, outer, radius, [255, 255, 255, 255]);

    const dotColor = [124, 58, 237, 255];
    const center = width / 2;
    const offset = width * 0.18;
    const dotRadius = Math.round(width * 0.055);

    drawCircle(center - offset, center - offset, dotRadius, dotColor);
    drawCircle(center + offset, center - offset, dotRadius, dotColor);
    drawCircle(center - offset, center + offset, dotRadius, dotColor);
    drawCircle(center + offset, center + offset, dotRadius, dotColor);
    drawCircle(center, center, dotRadius, dotColor);
  };

  draw();

  const scanlines = [];
  for (let y = 0; y < height; y += 1) {
    scanlines.push(0);
    scanlines.push(...rgba.subarray(y * width * 4, y * width * 4 + width * 4));
  }

  const rawData = Buffer.from(scanlines);
  const idat = zlib.deflateSync(rawData);

  const chunks = [];
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  chunks.push(pngHeader);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(writeChunk('IHDR', ihdr));
  chunks.push(writeChunk('IDAT', idat));
  chunks.push(writeChunk('IEND', Buffer.alloc(0)));

  fs.writeFileSync(path, Buffer.concat(chunks));
}

function writeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  typeBuf.copy(chunk, 4);
  data.copy(chunk, 8);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  chunk.writeUInt32BE(crc, 8 + data.length);
  return chunk;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (c >>> 8) ^ table[(c ^ buf[n]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}

const table = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  table[n] = c >>> 0;
}

writePNG('static/icon-192.png', 192);
writePNG('static/icon-512.png', 512);
console.log('Generated static/icon-192.png and static/icon-512.png');
