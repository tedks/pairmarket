import {
  parseMistAmount,
  parsePositionId,
  parseUserId,
} from "@pairmarket/core";
import { viewerMarketAction } from "../src/market-actions.ts";
import { seedAppState } from "../src/mock/seed.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function stateFor(viewer) {
  return { ...seedAppState(), viewer: parseUserId(viewer) };
}

function marketByTitle(state, title) {
  const market = [...state.markets.values()].find(
    (m) => m.content.title === title,
  );
  assert(market, `missing seeded market: ${title}`);
  return market;
}

const benState = stateFor("ben-okri");
const trading = marketByTitle(benState, "Will Cleo and Dru last 3 dates?");
assert(
  viewerMarketAction(benState, trading) === "Place wager",
  "partial stake with remaining invite cap stays actionable",
);

const capReached = {
  ...trading,
  positions: [
    ...trading.positions,
    {
      id: parsePositionId(`0x${"cafe".padStart(64, "0")}`),
      market: trading.id,
      owner: benState.viewer,
      outcome: "no",
      amountMist: parseMistAmount(500_000_000n),
      claimed: false,
    },
  ],
};
assert(
  viewerMarketAction(benState, capReached) === undefined,
  "stake cap reached removes wager action",
);

const proposed = marketByTitle(
  benState,
  "Will Eli and Fae go on a second date if introduced?",
);
assert(
  viewerMarketAction(benState, proposed) === "Accept invite",
  "pending invite is actionable",
);

const adaState = stateFor("ada-lovelace");
const attestationPending = marketByTitle(
  adaState,
  "Will Ada and Cleo still be together end of Q4?",
);
assert(
  viewerMarketAction(adaState, attestationPending) === "Attest outcome",
  "subject with missing attestation is actionable",
);

const settled = marketByTitle(adaState, "Did Ben and Dru last 3 dates?");
assert(
  viewerMarketAction(adaState, settled) === "Claim payout",
  "unclaimed winning position is actionable",
);

const faeState = stateFor("fae-shimizu");
assert(
  viewerMarketAction(faeState, proposed) === "Consent required",
  "pending subject consent is actionable",
);
