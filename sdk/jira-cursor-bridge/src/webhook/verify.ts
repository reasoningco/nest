import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(
  rawBody: Buffer | string,
  headerValue: string | null | undefined,
  secret: string,
): boolean {
  if (!headerValue) return false;
  const hex = headerValue.startsWith("sha256=")
    ? headerValue.slice("sha256=".length)
    : headerValue;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;

  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
