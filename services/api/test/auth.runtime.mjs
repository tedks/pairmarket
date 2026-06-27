import { parseTwitterSub } from "@pairmarket/core";
import { createPrototypeAuthApi } from "../src/index.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const auth = createPrototypeAuthApi();
const prefixed = auth.signInWithTwitter({
  sub: parseTwitterSub("twitter:ada"),
});
const raw = auth.signInWithTwitter({
  sub: parseTwitterSub("raw-twitter-sub-123"),
});

assert(
  prefixed.userId === "twitter:ada",
  "prefixed Twitter subjects map directly to user IDs",
);
assert(
  raw.userId === "twitter:raw-twitter-sub-123",
  "raw Twitter subjects are namespaced as user IDs",
);
assert(
  prefixed.sessionId !== raw.sessionId,
  "prototype auth creates independent sessions",
);
assert(
  prefixed.account.ownerKind === "custodial",
  "prototype auth exposes only the public owner kind",
);
assert(
  !("keyRef" in prefixed.account),
  "prototype auth must not expose KeyRef",
);
