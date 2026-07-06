import { Transaction } from "@mysten/sui/transactions";
import {
  parseMarketId,
  type MarketId,
  type MistAmount,
  type SuiAddress,
  type WagerOutcome,
} from "@pairmarket/core";
import type { OperationalizationKind } from "../types.ts";
import {
  SUI_CLOCK_OBJECT_ID,
  SUI_COIN_TYPE,
  type PairmarketMoveConfig,
} from "./config.ts";

const OUTCOME = {
  yes: 1,
  no: 2,
  invalid: 3,
} as const;

const textEncoder = new TextEncoder();

export type CreateMarketTxInput = {
  readonly config: PairmarketMoveConfig;
  readonly creator: SuiAddress;
  readonly operationalization: OperationalizationKind;
  readonly title: string;
  readonly prompt: string;
  readonly subjectA: SuiAddress;
  readonly subjectB: SuiAddress;
  readonly closeMs: number;
  readonly earliestAttestMs: number;
  readonly resolutionDeadlineMs: number;
  readonly challengeWindowMs: number;
  readonly disputeDeadlineMs: number;
  readonly feeBps: number;
  readonly resolverCommittee: readonly SuiAddress[];
};

export async function buildCreateMarketTransaction(
  input: CreateMarketTxInput,
): Promise<Transaction> {
  const tx = new Transaction();
  const contentHash = await sha256Bytes({
    title: input.title,
    prompt: input.prompt,
    operationalization: input.operationalization,
    subjectA: input.subjectA,
    subjectB: input.subjectB,
    resolutionDeadlineMs: input.resolutionDeadlineMs,
  });
  const metadataRef = textEncoder.encode(`local-browser:${hex(contentHash)}`);
  const subjectRef = await sha256Bytes({
    subjectA: input.subjectA,
    subjectB: input.subjectB,
  });

  tx.moveCall({
    target: `${input.config.packageId}::market::create_market`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.pure.vector("u8", [...contentHash]),
      tx.pure.vector("u8", [...metadataRef]),
      tx.pure.vector("u8", [...subjectRef]),
      tx.pure.vector("u8", [...textEncoder.encode("localnet-self-custody-v1")]),
      tx.pure.address(input.subjectA),
      tx.pure.address(input.subjectB),
      tx.pure.u64(input.closeMs),
      tx.pure.u64(input.earliestAttestMs),
      tx.pure.u64(input.resolutionDeadlineMs),
      tx.pure.u64(input.challengeWindowMs),
      tx.pure.u64(input.disputeDeadlineMs),
      tx.pure.u16(input.feeBps),
      tx.pure.vector("address", [...input.resolverCommittee, input.creator]),
      tx.object(input.config.configId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildConsentTransaction(
  config: PairmarketMoveConfig,
  marketId: MarketId,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::record_subject_consent`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(marketId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function buildMintInviteTransaction(
  config: PairmarketMoveConfig,
  marketId: MarketId,
  grantee: SuiAddress,
  maxStakeMist: MistAmount,
  expiresMs: number,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::mint_invite`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(marketId),
      tx.pure.address(grantee),
      tx.pure.u64(maxStakeMist as bigint),
      tx.pure.u64(expiresMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildPlaceTransaction(
  config: PairmarketMoveConfig,
  marketId: MarketId,
  inviteId: string,
  outcome: WagerOutcome,
  amountMist: MistAmount,
): Transaction {
  const tx = new Transaction();
  const [stake] = tx.splitCoins(tx.gas, [amountMist as bigint]);
  tx.moveCall({
    target: `${config.packageId}::market::place`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(marketId),
      tx.object(inviteId),
      stake,
      tx.pure.u8(OUTCOME[outcome]),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildSubmitAttestationTransaction(
  config: PairmarketMoveConfig,
  marketId: MarketId,
  outcome: "yes" | "no" | "invalid",
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::submit_attestation`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(marketId),
      tx.pure.u8(OUTCOME[outcome]),
      tx.pure.vector("u8", [...textEncoder.encode("localnet-attestation")]),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildFinalizeTransaction(
  config: PairmarketMoveConfig,
  marketId: MarketId,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::finalize`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(marketId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function buildClaimTransaction(
  config: PairmarketMoveConfig,
  marketId: MarketId,
  positionId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::claim`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(marketId), tx.object(positionId)],
  });
  return tx;
}

export function buildRefundTransaction(
  config: PairmarketMoveConfig,
  marketId: MarketId,
  positionId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::refund`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(marketId), tx.object(positionId)],
  });
  return tx;
}

export function findCreatedMarketId(result: unknown): MarketId | undefined {
  const found = findStringValue(result, "market_id");
  return found === undefined ? undefined : parseMarketId(found);
}

async function sha256Bytes(input: unknown): Promise<Uint8Array> {
  const data = textEncoder.encode(JSON.stringify(input));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function findStringValue(value: unknown, key: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringValue(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string") return direct;
  if (
    direct !== null &&
    typeof direct === "object" &&
    typeof (direct as Record<string, unknown>).id === "string"
  ) {
    return (direct as Record<string, string>).id;
  }

  for (const child of Object.values(record)) {
    const found = findStringValue(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
