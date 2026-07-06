import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const header = readFileSync(resolve(here, "../src/components/Header.tsx"), "utf8");

assert(
  header.includes("Twitter custody coming later"),
  "Twitter custody is visibly disabled",
);
assert(
  !header.includes("signInWithTwitter"),
  "Twitter sign-in is not wired into the header",
);
assert(
  !existsSync(resolve(here, "../src/auth/twitter-custody.ts")),
  "prototype Twitter custody implementation is absent",
);
