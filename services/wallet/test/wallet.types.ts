import {
  Plaintext,
  createTxIntent,
  defineSigningCustodyScope,
  parseMarketId,
  parseMistAmount,
  parseNonce,
  parsePreviewHash,
  parseSessionId,
  parseSuiAddress,
  parseUserId,
  type CustodyCap,
  type TxKind,
} from "@pairmarket/core";
import {
  createInMemoryWalletService,
  previewHashForPrototype,
  type AccountSigningGrant,
  type LoggableValue,
  type MarketSigningGrant,
} from "../src/index.js";

const wallet = createInMemoryWalletService();
const userId = parseUserId("twitter:twitter-sub-123");
const account = wallet.provisionCustodialAccount({ userId });
const publicAccount = wallet.publicAccount(account);
const sessionId = parseSessionId("1234567890123456789012");
wallet.registerSession({ userId, sessionId });

// @ts-expect-error The API-facing account view must not expose KeyRef.
publicAccount.keyRef;

const marketId = parseMarketId("0x2");
const sender = account.address;
const nonce = parseNonce("1234567890123456789012");
const previewHash = parsePreviewHash(
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const amount = parseMistAmount(10n);
const otherPlaintext = Plaintext.of(123);

function custodyCap(input: {
  readonly user: typeof userId;
  readonly scope: CustodyCap["scope"];
}): CustodyCap {
  return input as CustodyCap;
}

const placeIntent = createTxIntent({
  kind: "place-wager",
  sender,
  nonce,
  market: marketId,
  payload: {
    outcome: "yes",
    amountMist: amount,
  },
});

const marketGrant = {
  kind: "market",
  userId,
  txKind: "place-wager",
  marketId,
  maxAmountMist: amount,
  custodyCap: custodyCap({
    user: userId,
    scope: defineSigningCustodyScope({
      kind: "sign-market-tx",
      market: marketId,
      txKinds: ["place-wager"],
      maxAmountMist: amount,
    }),
  }),
} satisfies MarketSigningGrant<"place-wager">;

wallet.signPolicyGatedIntent({
  userId,
  sessionId,
  intent: placeIntent,
  grant: marketGrant,
  previewHash: previewHashForPrototype(placeIntent),
});

const accountGrant = {
  kind: "account",
  userId,
  txKind: "create-market",
  custodyCap: custodyCap({
    user: userId,
    scope: defineSigningCustodyScope({
      kind: "sign-account-tx",
      txKinds: ["create-market"],
    }),
  }),
} satisfies AccountSigningGrant<"create-market">;

wallet.signPolicyGatedIntent({
  userId,
  sessionId,
  intent: placeIntent,
  // @ts-expect-error Market-scoped intents require a market signing grant.
  grant: accountGrant,
  previewHash,
});

// @ts-expect-error Unknown Move entry points are not in the wallet TxKind union.
const unknownKind: TxKind = "finalize";
void unknownKind;

wallet.signPolicyGatedIntent({
  userId,
  sessionId,
  intent: {
    // @ts-expect-error Raw objects with unknown kinds are not TxIntent values.
    kind: "finalize",
    sender,
    nonce,
  },
  grant: accountGrant,
  previewHash,
});

const privateMarketCopy = Plaintext.of("will A and B last three dates?");

// @ts-expect-error Plaintext brands preserve their payload type.
const typedCopy: Plaintext<string> = otherPlaintext;
void typedCopy;

function acceptsAuditValue(value: LoggableValue): LoggableValue {
  return value;
}

// @ts-expect-error Plaintext wrappers are not acceptable audit-log values.
acceptsAuditValue(privateMarketCopy);
