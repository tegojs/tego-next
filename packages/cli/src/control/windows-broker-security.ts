import { DiagnosticError } from "@tego/contracts";
import { protocolDiagnostic } from "./protocol.js";

export const WINDOWS_BROKER_DESCRIPTOR_VERSION = 1;
export const WINDOWS_PIPE_FULL_CONTROL = 0x1f01ff;
export const WINDOWS_SYSTEM_SID = "S-1-5-18";
export const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";

const DESCRIPTOR_HEADER_BYTES = 12;
const ACCESS_RULE_HEADER_BYTES = 12;
const DESCRIPTOR_MAGIC = "TGSD";
const DESCRIPTOR_PROTECTED_DACL = 1;
const ACCESS_RULE_ALLOW = 1;
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)$/u;
const MAX_IDENTIFIER_AUTHORITY = "281474976710655";
const MAX_SUBAUTHORITY = "4294967295";

export interface WindowsBrokerSecurityAccessRule {
  readonly accessMask: number;
  readonly callback: false;
  readonly inherited: false;
  readonly sid: string;
  readonly type: "allow";
}

export interface WindowsBrokerSecurityDescriptor {
  readonly accessRules: readonly WindowsBrokerSecurityAccessRule[];
  readonly ownerSid: string;
  readonly protectedDacl: true;
}

function endpointUnsafe(): DiagnosticError {
  return new DiagnosticError(
    protocolDiagnostic("PROTOCOL_CONTROL_ENDPOINT_UNSAFE", "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"),
  );
}

function canonicalBoundedDecimal(value: string, maximum: string): boolean {
  return (
    CANONICAL_DECIMAL.test(value) &&
    (value.length < maximum.length || (value.length === maximum.length && value <= maximum))
  );
}

function isCanonicalSid(sid: string): boolean {
  const [prefix, revision, authority, ...subauthorities] = sid.split("-");
  return (
    prefix === "S" &&
    revision === "1" &&
    canonicalBoundedDecimal(authority ?? "", MAX_IDENTIFIER_AUTHORITY) &&
    subauthorities.length >= 1 &&
    subauthorities.length <= 15 &&
    subauthorities.every((value) => canonicalBoundedDecimal(value, MAX_SUBAUTHORITY))
  );
}

function readCanonicalSid(payload: Buffer, offset: number, length: number): string {
  if (length < 1 || offset < 0 || offset + length > payload.byteLength) throw endpointUnsafe();
  const encoded = payload.subarray(offset, offset + length);
  if (encoded.some((byte) => byte < 0x20 || byte > 0x7e)) throw endpointUnsafe();
  const sid = encoded.toString("ascii");
  if (!isCanonicalSid(sid) || !Buffer.from(sid, "ascii").equals(encoded)) {
    throw endpointUnsafe();
  }
  return sid;
}

export function decodeWindowsBrokerReadyDescriptor(
  value: Uint8Array,
): WindowsBrokerSecurityDescriptor {
  if (!(value instanceof Uint8Array)) throw endpointUnsafe();
  const payload = Buffer.from(value);
  if (
    payload.byteLength < DESCRIPTOR_HEADER_BYTES ||
    payload.toString("ascii", 0, 4) !== DESCRIPTOR_MAGIC ||
    payload.readUInt16BE(4) !== WINDOWS_BROKER_DESCRIPTOR_VERSION ||
    payload.readUInt16BE(6) !== DESCRIPTOR_PROTECTED_DACL
  ) {
    throw endpointUnsafe();
  }
  const ownerLength = payload.readUInt16BE(8);
  const aceCount = payload.readUInt16BE(10);
  let offset = DESCRIPTOR_HEADER_BYTES;
  const ownerSid = readCanonicalSid(payload, offset, ownerLength);
  offset += ownerLength;
  const accessRules: WindowsBrokerSecurityAccessRule[] = [];
  for (let index = 0; index < aceCount; index += 1) {
    if (offset + ACCESS_RULE_HEADER_BYTES > payload.byteLength) throw endpointUnsafe();
    const type = payload[offset];
    const inherited = payload[offset + 1];
    const callback = payload[offset + 2];
    const reserved = payload[offset + 3];
    const accessMask = payload.readUInt32BE(offset + 4);
    const sidLength = payload.readUInt16BE(offset + 8);
    const trailingReserved = payload.readUInt16BE(offset + 10);
    if (
      type !== ACCESS_RULE_ALLOW ||
      inherited !== 0 ||
      callback !== 0 ||
      reserved !== 0 ||
      accessMask !== WINDOWS_PIPE_FULL_CONTROL ||
      trailingReserved !== 0
    ) {
      throw endpointUnsafe();
    }
    offset += ACCESS_RULE_HEADER_BYTES;
    const sid = readCanonicalSid(payload, offset, sidLength);
    offset += sidLength;
    accessRules.push({ accessMask, callback: false, inherited: false, sid, type: "allow" });
  }
  if (offset !== payload.byteLength) throw endpointUnsafe();

  const expectedSids = [...new Set([ownerSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID])];
  if (
    accessRules.length !== expectedSids.length ||
    accessRules.some(({ sid }, index) => sid !== expectedSids[index]) ||
    new Set(accessRules.map(({ sid }) => sid)).size !== expectedSids.length
  ) {
    throw endpointUnsafe();
  }
  return { accessRules, ownerSid, protectedDacl: true };
}
