import { parseTwitterSub, userIdFromTwitterSub } from "../src/index.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  userIdFromTwitterSub(parseTwitterSub("twitter:ada")) === "twitter:ada",
  "prefixed Twitter subjects must not be double-prefixed",
);
assert(
  userIdFromTwitterSub(parseTwitterSub("raw-twitter-sub-123")) ===
    "twitter:raw-twitter-sub-123",
  "raw Twitter subjects must be namespaced as user IDs",
);
