/**
 * Content hash for optimistic concurrency control on agent writes.
 *
 * The operation router records the hash of each cell's content as the agent
 * last saw it (from read results); write operations carry that hash and the
 * applier — the live UI when connected, the headless handler otherwise —
 * rejects the write if the cell's current content no longer matches. This is
 * compare-and-swap at the point of application: immune to autosave latency
 * and to browser/server clock skew (which rule out timestamp-based checks).
 *
 * MUST stay in sync with node-server/src/notebook/cell-hash.ts (server copy).
 */
export function hashCellContent(content: string): string {
  // FNV-1a, 32-bit, hex — stable, fast, and tiny. Collisions are acceptable:
  // a false "unchanged" requires an adversarial collision; the cost of a
  // false conflict is one extra agent read.
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
