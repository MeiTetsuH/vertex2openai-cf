// ============================================================
// Express API Key manager with round-robin rotation
// ============================================================

export class KeyManager {
  private keys: string[];
  private index = 0;

  constructor(keys: string[]) {
    this.keys = keys;
  }

  /** Total number of keys available. */
  get totalKeys(): number {
    return this.keys.length;
  }

  /** Get the next key via round-robin. Returns [originalIndex, key] or null. */
  getKey(): [number, string] | null {
    if (this.keys.length === 0) return null;
    const idx = this.index % this.keys.length;
    this.index++;
    return [idx, this.keys[idx]];
  }

  /** Get all keys with their indices (for retry logic). */
  getAllKeys(): Array<[number, string]> {
    return this.keys.map((k, i) => [i, k]);
  }
}
