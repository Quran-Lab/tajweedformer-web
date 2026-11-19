// The weekly data piece. Since Core c3 (spec fix 16, quranlab-core f006676) the Core keeps every
// piece itself (in force, pending, last good) in its saved state, and the frame hands a lease answer's piece to it right
// after qlc_lease_accept and does nothing else with it (controller.js). The frame mirrored the rule before c3; the
// mirror is gone, and so is the piece the frame kept (core.piece): the Core's state comes back with the lease
// (lease-store.js). What stays here is the piece's id, for logs and tests.

/** A piece's id (u32 LE after the version byte, 18.6.7), from its bytes. */
export function pieceId(bytes) { return bytes.length >= 5 && bytes[0] === 1 ? (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0 : 0; }
