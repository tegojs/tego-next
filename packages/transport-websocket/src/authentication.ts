import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const AUTHENTICATION_DOMAIN = "tego-worker-session-v1";

export type WorkerSessionRole = "main" | "worker";

export function createAuthenticationNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function createAuthenticationProof(input: {
  readonly credential: string;
  readonly workerId: string;
  readonly senderNonce: string;
  readonly receiverNonce: string;
  readonly senderRole: WorkerSessionRole;
}): string {
  return createHmac("sha256", input.credential)
    .update(AUTHENTICATION_DOMAIN)
    .update("\0")
    .update(input.workerId)
    .update("\0")
    .update(input.senderNonce)
    .update("\0")
    .update(input.receiverNonce)
    .update("\0")
    .update(input.senderRole)
    .digest("base64url");
}

export function verifyAuthenticationProof(input: {
  readonly credential: string;
  readonly workerId: string;
  readonly senderNonce: string;
  readonly receiverNonce: string;
  readonly senderRole: WorkerSessionRole;
  readonly proof: string;
}): boolean {
  const expected = createAuthenticationProof(input);
  const expectedDigest = createHmac("sha256", AUTHENTICATION_DOMAIN).update(expected).digest();
  const receivedDigest = createHmac("sha256", AUTHENTICATION_DOMAIN).update(input.proof).digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}
