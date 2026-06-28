import { createPrototypeTwitterCustodyClient } from "../src/auth/twitter-custody.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const client = createPrototypeTwitterCustodyClient();
const profile = {
  id: "ada-lovelace",
  handle: "ada",
  displayName: "Ada Lovelace",
  address: "0x0000000000000000000000000000000000000000000000000000000000000ada",
  avatar: "AL",
};

const firstChallenge = client.beginSignIn(profile);
const secondChallenge = client.beginSignIn(profile);

assert(
  firstChallenge.nonce !== secondChallenge.nonce,
  "Twitter OAuth challenges use fresh nonces",
);

const first = await client.completeSignIn(firstChallenge);
const second = await client.completeSignIn(secondChallenge);

assert(first.sub === "twitter:ada", "session preserves Twitter subject");
assert(first.userId === "twitter:ada", "session maps Twitter subject to user");
assert(first.address === profile.address, "session exposes public Sui address");
assert(first.owner.kind === "custodial", "session exposes public owner kind");
assert(!("keyRef" in first.owner), "session must not expose custodial KeyRef");
assert(first.sessionId !== second.sessionId, "sessions are not reused");
