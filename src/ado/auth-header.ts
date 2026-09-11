/**
 * The two Authorization headers Azure DevOps accepts.
 *
 * They are not interchangeable: a brokered token is a bearer token, while a personal
 * access token is sent as a password against an empty user name. Getting this wrong
 * fails as a 203 page of HTML rather than a 401, which is hard to recognise.
 */

export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}

export function patHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

/** True when a string looks like a token rather than something pasted by mistake. */
export function looksLikePat(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 20 && !/\s/.test(trimmed);
}
