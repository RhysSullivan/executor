const slugifyRegex = /[^a-z0-9]+/g;

export const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(slugifyRegex, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

export const ensureUniqueSlug = async (
  base: string,
  hasCollision: (candidate: string) => Promise<boolean>,
): Promise<string> => {
  const normalizedBase = slugify(base);
  const seed = normalizedBase.length > 0 ? normalizedBase : "item";

  let counter = 0;
  while (true) {
    const candidate = counter === 0 ? seed : `${seed}-${counter + 1}`;
    if (!(await hasCollision(candidate))) {
      return candidate;
    }

    counter += 1;
  }
};
