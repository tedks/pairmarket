import {
  parseKeyRef,
  parseNonce,
  parseSuiAddress,
  parseTwitterSub,
} from "@pairmarket/core";
import { nextSelfCustodyState } from "../src/self-custody.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const walletAddress = parseSuiAddress("0x123");
const linked = {
  kind: "linked",
  sub: parseTwitterSub("twitter:ada"),
  address: parseSuiAddress("0x456"),
  owner: { kind: "custodial", keyRef: parseKeyRef("kms:pairmarket/ada") },
};

const selfCustody = nextSelfCustodyState(
  { kind: "anonymous" },
  {
    connected: true,
    address: walletAddress,
    walletName: "Burner",
    network: "testnet",
  },
);

assert(selfCustody?.kind === "self-custody", "wallet connect creates custody");
assert(selfCustody.address === walletAddress, "wallet address is preserved");
assert(selfCustody.network === "testnet", "wallet network is preserved");

const ignoredForTwitter = nextSelfCustodyState(linked, {
  connected: true,
  address: walletAddress,
  walletName: "Burner",
  network: "testnet",
});

assert(
  ignoredForTwitter === null,
  "wallet reconnect must not overwrite linked Twitter custody",
);

const ignoredForOauth = nextSelfCustodyState(
  { kind: "awaiting-oauth", nonce: parseNonce("nonce_waiting_1234567890") },
  {
    connected: true,
    address: walletAddress,
    walletName: "Burner",
    network: "testnet",
  },
);

assert(
  ignoredForOauth === null,
  "wallet reconnect must not overwrite pending OAuth custody",
);

const rejectedAddress = nextSelfCustodyState(
  { kind: "anonymous" },
  {
    connected: true,
    address: "not-a-sui-address",
    walletName: "Broken wallet",
    network: "testnet",
  },
);

assert(rejectedAddress === null, "invalid wallet address is ignored");

const disconnected = nextSelfCustodyState(selfCustody, {
  connected: false,
  address: undefined,
  walletName: undefined,
  network: "testnet",
});

assert(
  disconnected?.kind === "anonymous",
  "wallet disconnect clears self-custody",
);
