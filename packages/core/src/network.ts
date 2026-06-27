import type { Brand } from "./brand.js";
import type { SuiAddress, SuiObjectId } from "./ids.js";
import { parseError, type ParseResult, tryParse } from "./validation.js";

type ParsedUrl = {
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly href: string;
};

type UrlConstructor = new (input: string) => ParsedUrl;

export type SuiNetwork = "localnet" | "devnet" | "testnet" | "mainnet";

export type PairmarketEnv = "local" | "dev" | "test" | "prod";

export const networkByEnv = {
  local: "localnet",
  dev: "devnet",
  test: "testnet",
  prod: "mainnet",
} as const satisfies Record<PairmarketEnv, SuiNetwork>;

export type NetworkForEnv<TEnv extends PairmarketEnv> =
  (typeof networkByEnv)[TEnv];

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

  const Url = (globalThis as { readonly URL?: UrlConstructor }).URL;
  if (Url === undefined) {
    throw parseError(
      "invalid_sui_rpc_url_runtime",
      "SuiRpcUrl parsing requires a URL constructor",
      raw,
    );
  }

  let url: ParsedUrl;
  try {
    url = new Url(raw);
  } catch {
    throw parseError(
      "invalid_sui_rpc_url",
      "SuiRpcUrl must be a valid absolute URL",
      raw,
    );
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw parseError(
      "invalid_sui_rpc_url_scheme",
      "SuiRpcUrl must use http or https",
      raw,
    );
  }

  if (url.hostname.length === 0) {
    throw parseError(
      "invalid_sui_rpc_url_host",
      "SuiRpcUrl must include a host",
      raw,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw parseError(
      "invalid_sui_rpc_url_credentials",
      "SuiRpcUrl must not include credentials",
      raw,
    );
  }

  return url.href as SuiRpcUrl;
}

export function tryParseSuiRpcUrl(raw: unknown): ParseResult<SuiRpcUrl> {
  return tryParse(parseSuiRpcUrl, raw);
}
