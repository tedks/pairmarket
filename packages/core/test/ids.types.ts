import {
  parseMarketId,
  parseSuiAddress,
  parseNonce,
  parseTxDigest,
  tryParseTwitterSub,
  type MarketId,
  type PolicyBound,
  type SealCiphertext,
  type SuiAddress,
} from "../src/index";

const address = parseSuiAddress("0x2");
const market = parseMarketId("0x2");
const nonce = parseNonce("1234567890123456789012");
const digest = parseTxDigest("1111111111111111111111111111111111111111111");

void nonce;
void digest;

function requireAddress(value: SuiAddress): SuiAddress {
  return value;
}

requireAddress(address);

// @ts-expect-error Market IDs and wallet addresses are both Sui-shaped hex,
// but they are intentionally different brands.
requireAddress(market);

const rawString: string = "0x2";

// @ts-expect-error Unparsed strings are not branded addresses.
const forgedAddress: SuiAddress = rawString;

void forgedAddress;

const rejectedTwitterSub = tryParseTwitterSub("");
void rejectedTwitterSub;

type MarketBody = { readonly title: string };
type InviteBody = { readonly inviteCode: string };

declare const marketCiphertext: SealCiphertext<MarketBody>;
declare const inviteBlob: PolicyBound<InviteBody>;

void inviteBlob;

// @ts-expect-error Ciphertext brands carry the plaintext shape as a phantom.
const wrongCiphertext: SealCiphertext<InviteBody> = marketCiphertext;

void wrongCiphertext;
const marketStillBranded = market satisfies MarketId;
void marketStillBranded;
