import type { Brand } from "./brand.js";
import type { SuiAddress, SuiObjectId } from "./ids.js";
import { parseError, type ParseResult, tryParse } from "./validation.js";

const HTTP_URL_RE = /^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/;

export type SuiNetwork = "localnet" | "devnet" | "testnet" | "mainnet";

export type PairmarketEnv = "local" | "dev" | "test" | "prod";

export type NetworkForEnv<TEnv extends PairmarketEnv> = TEnv extends "local"
  ? "localnet"
  : TEnv extends "dev"
    ? "devnet"
    : TEnv extends "test"
      ? "testnet"
      : "mainnet";

export type SuiRpcUrl = Brand<`${"http" | "https"}://${string}`, "SuiRpcUrl">;

export type HostedNetworkEnv = Exclude<PairmarketEnv, "local">;

export type LocalNetworkFixture = {
  readonly env: "local";
  readonly network: "localnet";
  readonly rpcUrl: SuiRpcUrl;
  readonly faucetUrl: SuiRpcUrl;
  readonly packageId: SuiObjectId;
  readonly publisher: SuiAddress;
};

export type HostedNetworkFixture<TEnv extends HostedNetworkEnv> = {
  readonly env: TEnv;
  readonly network: NetworkForEnv<TEnv>;
  readonly rpcUrl: SuiRpcUrl;
  readonly packageId: SuiObjectId;
};

export type NetworkFixture<TEnv extends PairmarketEnv = PairmarketEnv> =
  TEnv extends "local"
    ? LocalNetworkFixture
    : TEnv extends HostedNetworkEnv
      ? HostedNetworkFixture<TEnv>
      : never;

export function parseSuiRpcUrl(raw: unknown): SuiRpcUrl {
  if (typeof raw !== "string") {
    throw parseError(
      "invalid_sui_rpc_url",
      "SuiRpcUrl must be an http(s) URL string",
      raw,
    );
  }

  if (HTTP_URL_RE.test(raw)) {
    return raw as SuiRpcUrl;
  }

  throw parseError(
    "invalid_sui_rpc_url",
    "SuiRpcUrl must be an http(s) URL string without credentials",
    raw,
  );
}

export function tryParseSuiRpcUrl(raw: unknown): ParseResult<SuiRpcUrl> {
  return tryParse(parseSuiRpcUrl, raw);
}
