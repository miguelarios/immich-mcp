/** Case- and accent-insensitive comparison key: "José Núñez" and "jose nunez" match. */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value.trim());
}

/** Escapes SQL LIKE wildcards so user text is matched literally, then wraps it for "contains". */
export function containsPattern(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
