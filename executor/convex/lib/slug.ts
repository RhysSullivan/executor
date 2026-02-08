const DEFAULT_MAX_RANDOM_SLUG_ATTEMPTS = 20;

export async function ensureUniqueSlug(
  baseSlug: string,
  hasCollision: (candidate: string) => Promise<boolean>,
  maxRandomAttempts = DEFAULT_MAX_RANDOM_SLUG_ATTEMPTS,
): Promise<string> {
  if (!(await hasCollision(baseSlug))) {
    return baseSlug;
  }

  for (let attempt = 0; attempt < maxRandomAttempts; attempt += 1) {
    const candidate = `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
    if (!(await hasCollision(candidate))) {
      return candidate;
    }
  }

  return `${baseSlug}-${Date.now()}`;
}
