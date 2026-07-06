import { parseSuiAddress, parseUserId } from "@pairmarket/core";
import {
  getCustody,
  getState,
  resetAppState,
  setCustody,
} from "../src/state/store.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const walletAddress = parseSuiAddress("0x1234");

resetAppState();
assert(getState().viewer === parseUserId("anonymous"), "state starts anonymous");
assert(getState().markets.size === 0, "state starts without seeded markets");
assert(getCustody().kind === "anonymous", "custody starts anonymous");

setCustody({
  kind: "self-custody",
  address: walletAddress,
  walletName: "Generated test wallet",
  network: "localnet",
});

assert(getCustody().kind === "self-custody", "wallet custody is recorded");
assert(
  getState().viewer === parseUserId(walletAddress),
  "wallet address becomes the viewer id",
);
assert(
  getState().users.get(parseUserId(walletAddress))?.address === walletAddress,
  "wallet viewer profile is materialized",
);

setCustody({ kind: "anonymous" });
assert(getState().viewer === parseUserId("anonymous"), "sign-out resets viewer");
