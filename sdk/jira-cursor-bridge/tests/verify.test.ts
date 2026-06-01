import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/webhook/verify.ts";

const secret = "super-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifySignature", () => {
  it("accepts a valid signature", () => {
    const body = '{"hello":"world"}';
    expect(verifySignature(body, sign(body), secret)).toBe(true);
  });

  it("accepts a hex-only signature without sha256= prefix", () => {
    const body = "x";
    const hex = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(body, hex, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"hello":"world"}';
    const sig = sign(body);
    expect(verifySignature(body + "x", sig, secret)).toBe(false);
  });

  it("rejects when header is missing", () => {
    expect(verifySignature("x", null, secret)).toBe(false);
    expect(verifySignature("x", undefined, secret)).toBe(false);
    expect(verifySignature("x", "", secret)).toBe(false);
  });

  it("rejects malformed hex", () => {
    expect(verifySignature("x", "sha256=not-hex!!!", secret)).toBe(false);
  });

  it("rejects wrong-length digest (constant-time-safe path)", () => {
    expect(verifySignature("x", "sha256=abcd", secret)).toBe(false);
  });
});
