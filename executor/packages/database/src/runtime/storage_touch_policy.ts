export function shouldTouchStorageOnRead(rawValue = process.env.AGENT_STORAGE_TOUCH_ON_READ): boolean {
  if (rawValue === undefined) {
    return true;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") {
    return false;
  }

  return true;
}
