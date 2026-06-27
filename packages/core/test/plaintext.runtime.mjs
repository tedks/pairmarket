import { Plaintext, makePlaintext, usePlaintext } from "../src/privacy.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(fn, message) {
  try {
    fn();
  } catch {
    return;
  }

  throw new Error(message);
}

const plaintext = makePlaintext({
  title: "Will A and B last 3 dates?",
  termsHash: "sha256:terms",
});

assert(plaintext instanceof Plaintext, "makePlaintext returns Plaintext");
assert(
  usePlaintext(plaintext, (raw) => raw.title) === "Will A and B last 3 dates?",
  "usePlaintext exposes the raw value only inside the continuation",
);
assert(
  plaintext.use((raw) => raw.termsHash) === "sha256:terms",
  "Plaintext.use exposes the raw value only inside the continuation",
);
assert(
  Object.keys(plaintext).length === 0,
  "Plaintext does not expose enumerable fields",
);
assert(
  Object.prototype.toString.call(plaintext) === "[object Plaintext]",
  "Plaintext has a safe object tag",
);
assert(
  String(plaintext) === "[object Plaintext]",
  "String() does not leak raw data",
);
assertThrows(
  () => JSON.stringify(plaintext),
  "JSON.stringify(Plaintext) must throw",
);
assertThrows(
  () => JSON.stringify({ plaintext }),
  "JSON.stringify({ plaintext }) must throw",
);
