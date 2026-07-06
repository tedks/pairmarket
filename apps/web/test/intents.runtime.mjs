import { parseMarketId, parseSuiObjectId } from "@pairmarket/core";
import {
  buildCreateMarketTransaction,
  findCreatedMarketId,
} from "../src/sui/market.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const packageId = parseSuiObjectId("0x1234");
const configId = parseSuiObjectId("0x5678");
const creatorProfile = parseSuiObjectId("0xcafe");
const subjectAProfile = parseSuiObjectId("0xaaaa");
const subjectBProfile = parseSuiObjectId("0xbbbb");
const now = Date.now();
const closeMs = now + 86_400_000;
const earliestAttestMs = closeMs + 3_600_000;
const resolutionDeadlineMs = earliestAttestMs + 86_400_000;

const tx = await buildCreateMarketTransaction({
  config: { packageId, configId },
  creatorProfile,
  operationalization: { kind: "lasts-n-dates", n: 3 },
  visibility: "friends",
  title: "Private localnet title",
  prompt: "Private localnet prompt",
  subjectAProfile,
  subjectBProfile,
  closeMs,
  earliestAttestMs,
  resolutionDeadlineMs,
  challengeWindowMs: 86_400_000,
  disputeDeadlineMs: resolutionDeadlineMs + 86_400_000,
  feeBps: 0,
  resolverCommittee: [creatorProfile],
});

assert(typeof tx === "object" && tx !== null, "create-market tx is built");

const marketId = findCreatedMarketId({
  Transaction: {
    events: [{ parsedJson: { market_id: "0xabc" } }],
  },
});

assert(
  marketId === parseMarketId("0xabc"),
  "created market id is extracted from transaction events",
);
