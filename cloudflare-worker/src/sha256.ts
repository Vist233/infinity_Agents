/**
 * Small incremental SHA-256 implementation for streamed R2/request bodies.
 * Web Crypto's digest API requires the complete ArrayBuffer, which is not a
 * safe option for multi-gigabyte artifacts.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function toHex(value: number): string {
  return value.toString(16).padStart(8, "0");
}

export class Sha256 {
  private readonly state = new Uint32Array(INITIAL);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytes = 0;
  private finished = false;

  update(input: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 digest already finalized");
    this.bytes += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      const copied = Math.min(64 - this.bufferLength, input.byteLength - offset);
      this.buffer.set(input.subarray(offset, offset + copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    if (!this.finished) {
      const bitLength = this.bytes * 8;
      this.buffer[this.bufferLength++] = 0x80;
      if (this.bufferLength > 56) {
        this.buffer.fill(0, this.bufferLength);
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
      this.buffer.fill(0, this.bufferLength, 56);
      const view = new DataView(this.buffer.buffer);
      view.setUint32(56, Math.floor(bitLength / 0x100000000), false);
      view.setUint32(60, bitLength >>> 0, false);
      this.compress(this.buffer);
      this.finished = true;
    }
    return Array.from(this.state, toHex).join("");
  }

  private compress(block: Uint8Array): void {
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const words = new Uint32Array(64);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const value = words[i - 15];
      const sigma0 = rotr(value, 7) ^ rotr(value, 18) ^ (value >>> 3);
      const previous = words[i - 2];
      const sigma1 = rotr(previous, 17) ^ rotr(previous, 19) ^ (previous >>> 10);
      words[i] = (words[i - 16] + sigma0 + words[i - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + K[i] + words[i]) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

export async function hashReadableStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes?: number,
): Promise<{ size: number; sha256: string }> {
  const reader = stream.getReader();
  const hash = new Sha256();
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value);
      size += bytes.byteLength;
      if (maximumBytes !== undefined && size > maximumBytes) {
        await reader.cancel("stream exceeds maximum size");
        throw new Error("stream exceeds maximum size");
      }
      hash.update(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return { size, sha256: hash.digestHex() };
}

export function hashText(value: string): string {
  return new Sha256().update(new TextEncoder().encode(value)).digestHex();
}
