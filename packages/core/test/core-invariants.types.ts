import {
  defineSigningCustodyScope,
  makePlaintext,
  networkByEnv,
  parseKeyRef,
  parseMarketId,
  parseMistAmount,
  parseSuiAddress,
  parseSuiObjectId,
  parseSuiRpcUrl,
  usePlaintext,
  type BrandName,
  type CustodyScopeTxIntent,
  type CustodyScopeTxKind,
  type KeyRef,
  type MarketScopedTxKind,
  type NetworkFixture,
  type Plaintext,
  type SigningCustodyScope,
  type SuiRpcUrl,
  type TxIntent,
} from "../src/index.js";

const keyRef = parseKeyRef("kms:pairmarket/user-1");

function requireKeyRef(value: KeyRef): KeyRef {
  return value;
}

requireKeyRef(keyRef);

// @ts-expect-error KeyRef strings must cross a parser/factory boundary first.
requireKeyRef("kms:pairmarket/user-1");

type KeyRefBrand = BrandName<KeyRef>;
const keyRefBrandName = "KeyRef" satisfies KeyRefBrand;

// @ts-expect-error Brands that share a primitive representation are distinct.
const wrongBrandName: KeyRefBrand = "UserId";

void keyRefBrandName;
void wrongBrandName;

type MarketTerms = {
  readonly title: string;
  readonly termsHash: string;
};

type InviteTerms = {
  readonly inviteCode: string;
};

const marketPlaintext = makePlaintext({
  title: "Will A and B last 3 dates?",
  termsHash: "sha256:terms",
} satisfies MarketTerms);
const plaintextTitle = usePlaintext(marketPlaintext, (raw) => raw.title);

function sendMarketTerms(value: MarketTerms): void {
  void value;
}

// @ts-expect-error Plaintext<T> is opaque and cannot escape as raw T.
sendMarketTerms(marketPlaintext);

// @ts-expect-error Plaintext brands carry the decrypted payload shape.
const wrongPlaintext: Plaintext<InviteTerms> = marketPlaintext;

void plaintextTitle;
void wrongPlaintext;

const market = parseMarketId("0x2");
const maxAmountMist = parseMistAmount(100n);

const placeWagerOnlyScope = defineSigningCustodyScope({
  kind: "sign-market-tx",
  market,
  txKinds: ["place-wager"],
  maxAmountMist,
} as const);

declare const placeWagerIntent: TxIntent<"place-wager">;
declare const createMarketIntent: TxIntent<"create-market">;
declare const refundIntent: TxIntent<"refund">;

const authorizedWager: CustodyScopeTxIntent<typeof placeWagerOnlyScope> =
  placeWagerIntent;

// @ts-expect-error A place-wager scope cannot authorize account-level intents.
const rejectedCreateMarket: CustodyScopeTxIntent<typeof placeWagerOnlyScope> =
  createMarketIntent;

type PlaceWagerOnlyKind = CustodyScopeTxKind<typeof placeWagerOnlyScope>;
const placeWagerKind = "place-wager" satisfies PlaceWagerOnlyKind;

// @ts-expect-error Scope txKinds remain the source of authorized intent kinds.
const wrongScopeKind: PlaceWagerOnlyKind = "create-market";

const runtimeMarketTxKinds: readonly MarketScopedTxKind[] = ["place-wager"];
const runtimeMarketScope: SigningCustodyScope = {
  kind: "sign-market-tx",
  market,
  txKinds: runtimeMarketTxKinds,
  maxAmountMist,
};

// Widened runtime scopes deliberately widen the helper result too; signing code
// must inspect the concrete scope value before authorizing a transaction.
const runtimeScopeNeedsPolicyCheck: CustodyScopeTxIntent<
  typeof runtimeMarketScope
> = refundIntent;

const invalidAccountScopeFixture = {
  kind: "sign-account-tx",
  txKinds: ["migrate-custody"],
} as const;

// @ts-expect-error Custody migration uses its own scope kind, not sign-account-tx.
const invalidAccountScope: SigningCustodyScope = invalidAccountScopeFixture;

void authorizedWager;
void rejectedCreateMarket;
void placeWagerKind;
void wrongScopeKind;
void runtimeScopeNeedsPolicyCheck;
void invalidAccountScope;

const rpcUrl = parseSuiRpcUrl("http://127.0.0.1:9000");
const packageId = parseSuiObjectId("0x2");
const publisher = parseSuiAddress("0x3");
const localNetwork = networkByEnv.local satisfies "localnet";

function requireRpcUrl(value: SuiRpcUrl): SuiRpcUrl {
  return value;
}

requireRpcUrl(rpcUrl);

// @ts-expect-error Network fixture URLs must be parsed before use.
requireRpcUrl("http://127.0.0.1:9000");

const localFixture = {
  env: "local",
  network: "localnet",
  rpcUrl,
  faucetUrl: rpcUrl,
  packageId,
  publisher,
} satisfies NetworkFixture<"local">;

const prodFixture = {
  env: "prod",
  network: "mainnet",
  rpcUrl,
  packageId,
} satisfies NetworkFixture<"prod">;

function requireLocalFixture(value: NetworkFixture<"local">): void {
  void value;
}

requireLocalFixture(localFixture);

// @ts-expect-error Mainnet/prod fixtures are not accepted as local fixtures.
requireLocalFixture(prodFixture);

void localNetwork;
