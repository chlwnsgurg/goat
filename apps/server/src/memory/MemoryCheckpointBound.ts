// A page may hold just one record. Include that worst-case envelope for every input row.
// Six bytes cover JSON escaping of any one UTF-8 byte (including control characters).
// Binary compact receipts decode to bounded JSON; their record overhead covers the expansion.
export const CHECKPOINT_BYTE_EXPANSION = 6;
export const CHECKPOINT_RECORD_OVERHEAD = 8192;
export const CHECKPOINT_PAGE_OVERHEAD = 4096;
export const checkpointBound = (bytes: number, rows: number) =>
  CHECKPOINT_PAGE_OVERHEAD +
  bytes * CHECKPOINT_BYTE_EXPANSION +
  rows * (CHECKPOINT_RECORD_OVERHEAD + CHECKPOINT_PAGE_OVERHEAD);
