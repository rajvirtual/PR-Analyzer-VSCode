/**
 * Recovering a JSON object from a model reply.
 *
 * Models wrap JSON in prose or fences even when told not to, so the object is
 * located by scanning for balanced braces rather than by trusting the whole reply.
 */
export function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  for (const open of ["{", "["] as const) {
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === open) {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === close) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(trimmed.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }

  return [...new Set(candidates)];
}

export function parseFirstJson<T>(raw: string): T | null {
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Models leave real newlines and tabs inside string values (an "example" written
      // one per line), which JSON forbids; escaping them recovers the object.
      try {
        return JSON.parse(escapeControlCharsInStrings(candidate)) as T;
      } catch {
        // Try the next candidate; a partial match is expected when the reply has prose.
      }
    }
  }
  return null;
}

/** Escapes control characters that appear unescaped inside a JSON string value. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const char of json) {
    if (!inString) {
      out += char;
      if (char === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += char;
      escaped = false;
    } else if (char === "\\") {
      out += char;
      escaped = true;
    } else if (char === '"') {
      out += char;
      inString = false;
    } else if (char < "\u0020") {
      const code = char.charCodeAt(0);
      out +=
        code === 0x0a
          ? "\\n"
          : code === 0x0d
            ? "\\r"
            : code === 0x09
              ? "\\t"
              : `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }

  return out;
}
