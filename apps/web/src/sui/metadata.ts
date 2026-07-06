import type { MarketId, SuiObjectId } from "@pairmarket/core";
import type { OperationalizationKind } from "../types.ts";

export type LocalMarketMetadata = {
  readonly title: string;
  readonly prompt: string;
  readonly operationalization: OperationalizationKind;
};

function metadataKey(packageId: SuiObjectId, marketId: MarketId): string {
  return `pairmarket:localnet:${packageId}:market:${marketId}:metadata`;
}

export function saveLocalMarketMetadata(
  packageId: SuiObjectId,
  marketId: MarketId,
  metadata: LocalMarketMetadata,
): void {
  window.localStorage.setItem(
    metadataKey(packageId, marketId),
    JSON.stringify(metadata),
  );
}

export function loadLocalMarketMetadata(
  packageId: SuiObjectId,
  marketId: MarketId,
): LocalMarketMetadata {
  const raw = window.localStorage.getItem(metadataKey(packageId, marketId));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<LocalMarketMetadata>;
      if (
        typeof parsed.title === "string" &&
        typeof parsed.prompt === "string"
      ) {
        return {
          title: parsed.title,
          prompt: parsed.prompt,
          operationalization: isOperationalizationKind(
            parsed.operationalization,
          )
            ? parsed.operationalization
            : defaultOperationalization(),
        };
      }
    } catch {
      // Ignore malformed local display metadata; chain state remains authoritative.
    }
  }

  return {
    title: `Market ${marketId.slice(0, 10)}`,
    prompt: "Encrypted metadata is not available in this browser.",
    operationalization: defaultOperationalization(),
  };
}

function isOperationalizationKind(
  value: unknown,
): value is OperationalizationKind {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "lasts-n-dates":
      return isIntegerInRange(record.n, 1, 20);
    case "together-by-date":
    case "meet-by-date":
      return isPositiveSafeInteger(record.deadlineMs);
    default:
      return false;
  }
}

function defaultOperationalization(): OperationalizationKind {
  return { kind: "lasts-n-dates", n: 3 };
}

function isIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
