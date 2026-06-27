import {
  ParseError,
  parseMarketId,
  parseSuiAddress,
  parseTwitterSub,
  type MarketId,
  type PolicyBound,
  type SealCiphertext,
  type SuiAddress,
} from "../src/index";

const address = parseSuiAddress("0x2");
const normalized =
  "0x0000000000000000000000000000000000000000000000000000000000000002";

if (String(address) !== normalized) {
  throw new Error("parseSuiAddress must normalize to 32-byte lowercase hex");
}

const market = parseMarketId("0x2");

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

try {
  parseTwitterSub("");
  throw new Error("parseTwitterSub should reject empty input");
} catch (error) {
  if (!(error instanceof ParseError)) {
    throw error;
  }
}

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
