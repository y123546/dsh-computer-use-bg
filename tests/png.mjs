/**
 * Minimal PNG reader, for tests only.
 *
 * A cropped screenshot is only correct if the *pixels* are the right region. Checking
 * the byte length would pass for any image at all, so the test decodes the file and
 * looks at a pixel. Node ships zlib, and Chrome writes non-interlaced 8-bit RGB(A),
 * which is the whole format — no dependency needed.
 */

import { inflateSync } from 'node:zlib';

export function readPng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const chunks = [];

  for (let offset = 8; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
      if (buffer[start + 12] !== 0) throw new Error('interlaced PNG is not supported here');
    } else if (type === 'IDAT') {
      chunks.push(buffer.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4;
  }

  if (bitDepth !== 8) throw new Error(`unexpected bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = value & 0xff;
    }
  }

  return {
    width,
    height,
    channels,
    /** [r, g, b] at a pixel, clamped to the image. */
    pixel(x, y) {
      const px = Math.max(0, Math.min(width - 1, Math.round(x)));
      const py = Math.max(0, Math.min(height - 1, Math.round(y)));
      const i = (py * width + px) * channels;
      const r = pixels[i];
      const g = channels >= 3 ? pixels[i + 1] : r;
      const b = channels >= 3 ? pixels[i + 2] : r;
      return [r, g, b];
    },
    /** How much of the image matches a colour, 0..1 — used to prove a crop is not blank. */
    coverage(test, step = 7) {
      let hit = 0;
      let total = 0;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          total += 1;
          if (test(this.pixel(x, y))) hit += 1;
        }
      }
      return total === 0 ? 0 : hit / total;
    },
  };
}

/** True when a pixel is recognisably red (the fixture box is pure #f00). */
export const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90;
