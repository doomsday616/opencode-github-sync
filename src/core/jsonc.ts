/**
 * Dependency-free JSONC support.
 *
 * OpenCode config files are JSON with comments and trailing commas. We cannot
 * pull in a parser dependency because this module is loaded inside the OpenCode
 * runtime, so the stripping is done by hand. String literals are copied
 * verbatim so `//` or `/*` inside a value is never mistaken for a comment.
 */

export function parseJsonc<T = any>(text: string): T {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  let out = "";
  let i = 0;
  const n = s.length;
  // Index in `out` of a comma that may turn out to be a trailing comma.
  let lastComma = -1;

  while (i < n) {
    const ch = s[i]!;
    const next = i + 1 < n ? s[i + 1]! : "";

    // String literal — copy verbatim, honouring escapes.
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const cc = s[i]!;
        out += cc;
        if (cc === "\\" && i + 1 < n) {
          out += s[i + 1]!;
          i += 2;
          continue;
        }
        i++;
        if (cc === '"') break;
      }
      lastComma = -1;
      continue;
    }

    // Line comment.
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && s[i] !== "\n") i++;
      continue;
    }

    // Block comment.
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Whitespace keeps a pending comma alive.
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      out += ch;
      i++;
      continue;
    }

    // A closing bracket retroactively deletes a pending trailing comma.
    if (ch === "}" || ch === "]") {
      if (lastComma !== -1) {
        out = out.slice(0, lastComma) + out.slice(lastComma + 1);
        lastComma = -1;
      }
    }

    out += ch;
    lastComma = ch === "," ? out.length - 1 : -1;
    i++;
  }

  try {
    return JSON.parse(out) as T;
  } catch (e) {
    throw new Error(`JSONC parse error: ${(e as Error).message}`);
  }
}

export function tryParseJsonc<T = any>(text: string): T | undefined {
  try {
    return parseJsonc<T>(text);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `patch` into `base`, returning a new object.
 *
 * - Plain objects merge key by key.
 * - Arrays and scalars are replaced wholesale (an override should be able to
 *   shorten a list, which a concat-merge could never express).
 * - An explicit `null` in the patch deletes the key.
 */
export function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const result: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
