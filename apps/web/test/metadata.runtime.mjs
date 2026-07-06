import { parseMarketId, parseSuiObjectId } from "@pairmarket/core";
import {
  loadLocalMarketMetadata,
  saveLocalMarketMetadata,
} from "../src/sui/metadata.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createLocalStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    clear() {
      values.clear();
    },
  };
}

globalThis.window = { localStorage: createLocalStorage() };

const packageId = parseSuiObjectId("0x1234");
const marketId = parseMarketId("0xabcd");
const key = `pairmarket:localnet:${packageId}:market:${marketId}:metadata`;

saveLocalMarketMetadata(packageId, marketId, {
  title: "Real title",
  prompt: "Real prompt",
  operationalization: {
    kind: "meet-by-date",
    deadlineMs: Date.now() + 86_400_000,
  },
});

{
  const loaded = loadLocalMarketMetadata(packageId, marketId);
  assert(loaded.title === "Real title", "saved title round-trips");
  assert(loaded.prompt === "Real prompt", "saved prompt round-trips");
  assert(
    loaded.operationalization.kind === "meet-by-date",
    "saved op round-trips",
  );
}

window.localStorage.setItem(
  key,
  JSON.stringify({ title: "Old title", prompt: "Old prompt" }),
);

{
  const loaded = loadLocalMarketMetadata(packageId, marketId);
  assert(loaded.title === "Old title", "old local metadata keeps title");
  assert(loaded.prompt === "Old prompt", "old local metadata keeps prompt");
  assert(
    loaded.operationalization.kind === "lasts-n-dates" &&
      loaded.operationalization.n === 3,
    "old local metadata gets default operationalization",
  );
}

window.localStorage.setItem(
  key,
  JSON.stringify({
    title: "Bad op title",
    prompt: "Bad op prompt",
    operationalization: { kind: "lasts-n-dates", n: Number.NaN },
  }),
);

{
  const loaded = loadLocalMarketMetadata(packageId, marketId);
  assert(loaded.title === "Bad op title", "bad op metadata keeps title");
  assert(loaded.prompt === "Bad op prompt", "bad op metadata keeps prompt");
  assert(
    loaded.operationalization.kind === "lasts-n-dates" &&
      loaded.operationalization.n === 3,
    "bad op metadata falls back to default operationalization",
  );
}
