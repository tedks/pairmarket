import {
  parseSuiObjectId,
  type SuiObjectId,
  tryParseSuiObjectId,
} from "@pairmarket/core";

export type PairmarketMoveConfig = {
  readonly packageId: SuiObjectId;
  readonly configId: SuiObjectId;
};

export function pairmarketMoveConfig(): PairmarketMoveConfig | undefined {
  const packageId = tryParseSuiObjectId(
    import.meta.env.VITE_PAIRMARKET_MOVE_PACKAGE_ID,
  );
  const configId = tryParseSuiObjectId(
    import.meta.env.VITE_PAIRMARKET_MOVE_CONFIG_ID,
  );

  if (!packageId.ok || !configId.ok) return undefined;
  return { packageId: packageId.value, configId: configId.value };
}

export function requirePairmarketMoveConfig(): PairmarketMoveConfig {
  const config = pairmarketMoveConfig();
  if (config === undefined) {
    throw new Error(
      "Pairmarket localnet package is not deployed. Run pnpm devstack:deploy.",
    );
  }
  return config;
}

export const SUI_COIN_TYPE = "0x2::sui::SUI";
export const SUI_CLOCK_OBJECT_ID = parseSuiObjectId("0x6");
