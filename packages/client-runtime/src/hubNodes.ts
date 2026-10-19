export function isHubNodesUnsupportedError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < 40) {
    const value = pending.pop();
    if (value === null || value === undefined || visited.has(value)) continue;
    visited.add(value);
    if (typeof value === "string") {
      if (/^Unknown request tag: hub\.nodes\.[a-z]+$/iu.test(value)) return true;
    } else if (typeof value === "object") {
      for (const key of ["message", "reason", "cause", "defect", "error", "reasons"]) {
        if (key in value) pending.push(Reflect.get(value, key));
      }
      if (Array.isArray(value)) pending.push(...value);
    }
  }
  return false;
}
