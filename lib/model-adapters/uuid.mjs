// uuidv7 — time-ordered IDs for call_id in the model ledger. Same
// generator the runtime uses for run events (kept duplicated rather
// than imported from agix-runtime.mjs to avoid a cycle: runtime
// imports the model module to build getModel(), the model module
// would otherwise import the runtime for uuidv7).
//
// RFC 9562 §5.7.

export function uuidv7() {
  const ms = BigInt(Date.now());
  const random = new Uint8Array(10);
  globalThis.crypto.getRandomValues(random);
  const hex = (n) => n.toString(16).padStart(2, '0');
  const tsHex = ms.toString(16).padStart(12, '0');
  random[0] = (random[0] & 0x0f) | 0x70;
  random[2] = (random[2] & 0x3f) | 0x80;
  return (
    tsHex.slice(0, 8) + '-' +
    tsHex.slice(8, 12) + '-' +
    hex(random[0]) + hex(random[1]) + '-' +
    hex(random[2]) + hex(random[3]) + '-' +
    [...random.slice(4, 10)].map(hex).join('')
  );
}
