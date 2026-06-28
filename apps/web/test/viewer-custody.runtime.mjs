import {
  parseNonce,
  parseSessionId,
  parseSuiAddress,
  parseTwitterSub,
  parseUserId,
} from "@pairmarket/core";
import {
  getCustody,
  getState,
  resetMockState,
  setCustody,
  setPrototypeViewer,
  signInWithTwitter,
} from "../src/mock/store.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const ada = parseUserId("ada-lovelace");
const ben = parseUserId("ben-okri");

resetMockState();
assert(getState().viewer === ada, "seed viewer starts as Ada");
await signInWithTwitter();
assert(getCustody().kind === "linked", "Twitter sign-in links custody");
assert(getCustody().sub === "twitter:ada", "linked custody belongs to Ada");

setPrototypeViewer(ben);
assert(getState().viewer === ben, "viewer switch updates the active viewer");
assert(
  getCustody().kind === "anonymous",
  "viewer switch drops linked Twitter custody instead of carrying stale auth",
);

resetMockState();
const pendingSignIn = signInWithTwitter();
assert(
  getCustody().kind === "awaiting-oauth",
  "Twitter sign-in enters pending OAuth synchronously",
);

setPrototypeViewer(ben);
assert(
  getCustody().kind === "anonymous",
  "viewer switch cancels pending OAuth custody for the previous viewer",
);
await pendingSignIn;
assert(
  getCustody().kind === "anonymous",
  "stale OAuth completion cannot relink custody after a viewer switch",
);

const selfCustodyAddress = parseSuiAddress("0x1234");
resetMockState();
setCustody({
  kind: "self-custody",
  address: selfCustodyAddress,
  walletName: "Burner",
  network: "testnet",
});
setPrototypeViewer(ben);
assert(
  getCustody().kind === "self-custody",
  "viewer switch keeps self-custody because the external wallet owns auth",
);
assert(
  getCustody().address === selfCustodyAddress,
  "viewer switch preserves the connected wallet address",
);

resetMockState();
setCustody({
  kind: "linked",
  sub: parseTwitterSub("twitter:ada"),
  userId: parseUserId("twitter:ada"),
  sessionId: parseSessionId("twitter_session_1234567890"),
  address: parseSuiAddress("0xada"),
  owner: { kind: "custodial" },
});
setPrototypeViewer(ada);
assert(
  getCustody().kind === "linked",
  "selecting the already-active viewer does not churn custody",
);

resetMockState();
setCustody({
  kind: "awaiting-oauth",
  nonce: parseNonce("twitter_oauth_1234567890"),
});
setPrototypeViewer(ben);
assert(
  getCustody().kind === "anonymous",
  "pending Twitter OAuth is viewer-scoped and resets on viewer changes",
);
