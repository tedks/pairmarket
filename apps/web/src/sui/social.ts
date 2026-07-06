import { Transaction } from "@mysten/sui/transactions";
import { parseSuiObjectId, type SuiObjectId } from "@pairmarket/core";
import type { PairmarketMoveConfig } from "./config.ts";

const textEncoder = new TextEncoder();

export function buildCreateProfileTransaction(
  config: PairmarketMoveConfig,
  handle: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::create_profile`,
    arguments: [
      tx.pure.vector("u8", [...textEncoder.encode(cleanHandle(handle))]),
    ],
  });
  return tx;
}

export function buildRequestFriendshipTransaction(
  config: PairmarketMoveConfig,
  requesterProfileId: SuiObjectId,
  targetProfileId: SuiObjectId,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::request_friendship`,
    arguments: [tx.object(requesterProfileId), tx.object(targetProfileId)],
  });
  return tx;
}

export function buildAcceptFriendshipTransaction(
  config: PairmarketMoveConfig,
  requestId: SuiObjectId,
  accepterProfileId: SuiObjectId,
  requesterProfileId: SuiObjectId,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::market::accept_friendship`,
    arguments: [
      tx.object(requestId),
      tx.object(accepterProfileId),
      tx.object(requesterProfileId),
    ],
  });
  return tx;
}

export function findCreatedProfileId(result: unknown): SuiObjectId | undefined {
  const found = findStringValue(result, "profile_id");
  return found === undefined ? undefined : parseSuiObjectId(found);
}

function cleanHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
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
