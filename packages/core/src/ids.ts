import type { Brand } from "./brand.js";
import { parseError, type ParseResult, tryParse } from "./validation.js";

export type UserId = Brand<string, "UserId">;
export type TwitterSub = Brand<string, "TwitterSub">;
export type SuiAddress = Brand<`0x${string}`, "SuiAddress">;
export type SuiObjectId = Brand<`0x${string}`, "SuiObjectId">;
export type MarketId = Brand<`0x${string}`, "MarketId">;
export type InviteId = Brand<string, "InviteId">;
export type PositionId = Brand<`0x${string}`, "PositionId">;
export type WalrusBlobId = Brand<string, "WalrusBlobId">;
export type SealPolicyId = Brand<string, "SealPolicyId">;
export type KeyRef = Brand<string, "KeyRef">;
export type Nonce = Brand<string, "Nonce">;
export type TxDigest = Brand<string, "TxDigest">;
export type PolicyEpoch = Brand<number, "PolicyEpoch">;
export type UnixMs = Brand<number, "UnixMs">;
export type MistAmount = Brand<bigint, "MistAmount">;

const SUI_HEX_RE = /^0[xX][0-9a-fA-F]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VISIBLE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._~:/+=-]{0,511}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22,512}$/;
const TX_DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export function parseSuiAddress(raw: unknown): SuiAddress {
  return parseSuiHex(raw, "SuiAddress") as SuiAddress;
}

export function tryParseSuiAddress(raw: unknown): ParseResult<SuiAddress> {
  return tryParse(parseSuiAddress, raw);
}

export function parseSuiObjectId(raw: unknown): SuiObjectId {
  return parseSuiHex(raw, "SuiObjectId") as SuiObjectId;
}

export function tryParseSuiObjectId(raw: unknown): ParseResult<SuiObjectId> {
  return tryParse(parseSuiObjectId, raw);
}

export function parseMarketId(raw: unknown): MarketId {
  return parseSuiHex(raw, "MarketId") as MarketId;
}

export function tryParseMarketId(raw: unknown): ParseResult<MarketId> {
  return tryParse(parseMarketId, raw);
}

export function parsePositionId(raw: unknown): PositionId {
  return parseSuiHex(raw, "PositionId") as PositionId;
}

export function tryParsePositionId(raw: unknown): ParseResult<PositionId> {
  return tryParse(parsePositionId, raw);
}

export function parseUserId(raw: unknown): UserId {
  return parseOpaqueToken(raw, "UserId", TOKEN_RE) as UserId;
}

export function tryParseUserId(raw: unknown): ParseResult<UserId> {
  return tryParse(parseUserId, raw);
}

export function parseTwitterSub(raw: unknown): TwitterSub {
  return parseOpaqueToken(raw, "TwitterSub", TOKEN_RE) as TwitterSub;
}

export function tryParseTwitterSub(raw: unknown): ParseResult<TwitterSub> {
  return tryParse(parseTwitterSub, raw);
}

export function parseInviteId(raw: unknown): InviteId {
  return parseOpaqueToken(raw, "InviteId", TOKEN_RE) as InviteId;
}

export function tryParseInviteId(raw: unknown): ParseResult<InviteId> {
  return tryParse(parseInviteId, raw);
}

export function parseWalrusBlobId(raw: unknown): WalrusBlobId {
  return parseOpaqueToken(
    raw,
    "WalrusBlobId",
    VISIBLE_TOKEN_RE,
  ) as WalrusBlobId;
}

export function tryParseWalrusBlobId(raw: unknown): ParseResult<WalrusBlobId> {
  return tryParse(parseWalrusBlobId, raw);
}

export function parseSealPolicyId(raw: unknown): SealPolicyId {
  return parseOpaqueToken(
    raw,
    "SealPolicyId",
    VISIBLE_TOKEN_RE,
  ) as SealPolicyId;
}

export function tryParseSealPolicyId(raw: unknown): ParseResult<SealPolicyId> {
  return tryParse(parseSealPolicyId, raw);
}

export function parseKeyRef(raw: unknown): KeyRef {
  return parseOpaqueToken(raw, "KeyRef", VISIBLE_TOKEN_RE) as KeyRef;
}

export function tryParseKeyRef(raw: unknown): ParseResult<KeyRef> {
  return tryParse(parseKeyRef, raw);
}

export function parseNonce(raw: unknown): Nonce {
  return parseOpaqueToken(raw, "Nonce", NONCE_RE) as Nonce;
}

export function tryParseNonce(raw: unknown): ParseResult<Nonce> {
  return tryParse(parseNonce, raw);
}

export function parseTxDigest(raw: unknown): TxDigest {
  return parseOpaqueToken(raw, "TxDigest", TX_DIGEST_RE) as TxDigest;
}

export function tryParseTxDigest(raw: unknown): ParseResult<TxDigest> {
  return tryParse(parseTxDigest, raw);
}

export function parsePolicyEpoch(raw: unknown): PolicyEpoch {
  return parseNonNegativeSafeInteger(raw, "PolicyEpoch") as PolicyEpoch;
}

export function tryParsePolicyEpoch(raw: unknown): ParseResult<PolicyEpoch> {
  return tryParse(parsePolicyEpoch, raw);
}

export function parseUnixMs(raw: unknown): UnixMs {
  return parseNonNegativeSafeInteger(raw, "UnixMs") as UnixMs;
}

export function tryParseUnixMs(raw: unknown): ParseResult<UnixMs> {
  return tryParse(parseUnixMs, raw);
}

export function parseMistAmount(raw: unknown): MistAmount {
  if (typeof raw !== "bigint" || raw < 0n) {
    throw parseError(
      "invalid_mist_amount",
      "MistAmount must be a non-negative bigint",
      raw,
    );
  }

  return raw as MistAmount;
}

export function tryParseMistAmount(raw: unknown): ParseResult<MistAmount> {
  return tryParse(parseMistAmount, raw);
}

function parseSuiHex(raw: unknown, label: string): `0x${string}` {
  if (typeof raw !== "string" || !SUI_HEX_RE.test(raw)) {
    throw parseError(
      "invalid_sui_hex",
      `${label} must be a 0x-prefixed hex string of at most 32 bytes`,
      raw,
    );
  }

  const hex = raw.slice(2).toLowerCase().padStart(64, "0");
  if (/^0+$/.test(hex)) {
    throw parseError(
      "invalid_sui_hex",
      `${label} must not be the zero address`,
      raw,
    );
  }

  return `0x${hex}`;
}

function parseOpaqueToken(
  raw: unknown,
  label: string,
  pattern: RegExp,
): string {
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw parseError(
      "invalid_opaque_token",
      `${label} must be a non-empty opaque token without whitespace or control characters`,
      raw,
    );
  }

  return raw;
}

function parseNonNegativeSafeInteger(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw parseError(
      "invalid_nonnegative_integer",
      `${label} must be a non-negative safe integer`,
      raw,
    );
  }

  return raw;
}
