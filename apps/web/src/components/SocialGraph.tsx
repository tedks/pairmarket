import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { Transaction } from "@mysten/sui/transactions";
import type { SuiObjectId, UserId } from "@pairmarket/core";
import type { AppState, UserProfile } from "../types.ts";
import { pairmarketMoveConfig } from "../sui/config.ts";
import { useExecuteSuiTransaction } from "../sui/execute.ts";
import {
  buildAcceptFriendshipTransaction,
  buildCreateProfileTransaction,
  buildRequestFriendshipTransaction,
  findCreatedProfileId,
} from "../sui/social.ts";

type Props = {
  readonly state: AppState;
  readonly refresh: () => void;
};

type FriendSuggestion = {
  readonly profile: UserProfile;
  readonly via: readonly UserProfile[];
};

export function SocialGraph({ state, refresh }: Props): JSX.Element {
  const config = pairmarketMoveConfig();
  const execute = useExecuteSuiTransaction();
  const [handle, setHandle] = useState("");
  const [friendHandle, setFriendHandle] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const viewer = state.users.get(state.viewer);
  const viewerProfileId = viewer?.profileObjectId;
  const friends = useMemo(
    () =>
      viewerProfileId === undefined ? [] : directFriends(state, state.viewer),
    [state, viewerProfileId],
  );
  const suggestions = useMemo(
    () =>
      viewerProfileId === undefined
        ? []
        : friendSuggestions(state, state.viewer).slice(0, 12),
    [state, viewerProfileId],
  );
  const resolvedFriend = resolveProfile(state, friendHandle);

  const runTx = (
    transaction: Transaction,
    after?: (result: unknown) => void,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        const result = await execute(transaction);
        after?.(result);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <section className="account-panel">
      <header className="market-list-head">
        <h1>Social graph</h1>
        <p className="market-list-sub">
          Profile objects are the app identity; wallets only control them.
        </p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="card">
        <h2 className="card-title">Profile object</h2>
        <div className="card-body">
          {viewerProfileId === undefined ? (
            <form
              className="wager-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (config === undefined || handle.trim() === "") return;
                runTx(
                  buildCreateProfileTransaction(config, handle),
                  (result) => {
                    const profileId = findCreatedProfileId(result);
                    if (profileId !== undefined) setHandle("");
                  },
                );
              }}
            >
              <label className="stake-input">
                <span>Handle</span>
                <input
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="@tedks"
                  data-testid="profile-handle"
                />
              </label>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={config === undefined || busy || handle.trim() === ""}
                data-testid="create-profile"
              >
                Create profile
              </button>
            </form>
          ) : (
            <>
              <div className="kv">
                <span className="kv-k">Handle</span>
                <span className="kv-v">@{viewer?.handle}</span>
              </div>
              <div className="kv">
                <span className="kv-k">Profile object</span>
                <span className="kv-v mono">{viewerProfileId}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Add friend</h2>
        <div className="card-body">
          <form
            className="wager-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (
                config === undefined ||
                viewerProfileId === undefined ||
                resolvedFriend === undefined
              ) {
                return;
              }
              runTx(
                buildRequestFriendshipTransaction(
                  config,
                  viewerProfileId,
                  resolvedFriend.profileObjectId,
                ),
              );
              setFriendHandle("");
            }}
          >
            <label className="stake-input">
              <span>Friend handle</span>
              <input
                type="text"
                value={friendHandle}
                onChange={(e) => setFriendHandle(e.target.value)}
                placeholder="@heyellieday"
                data-testid="friend-handle"
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                config === undefined ||
                busy ||
                viewerProfileId === undefined ||
                resolvedFriend === undefined
              }
              data-testid="request-friend"
            >
              Request friendship
            </button>
          </form>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Friend requests</h2>
        <div className="card-body">
          {state.friendRequests.length === 0 ? (
            <p className="card-empty">No pending requests.</p>
          ) : (
            <ul className="invite-list">
              {state.friendRequests.map((request) => {
                const requester = state.users.get(request.requester);
                return (
                  <li key={request.id} className="invite-row">
                    <span>{requester?.displayName ?? request.requester}</span>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={
                        config === undefined ||
                        busy ||
                        viewerProfileId === undefined ||
                        requester?.profileObjectId === undefined
                      }
                      onClick={() => {
                        if (
                          config !== undefined &&
                          viewerProfileId !== undefined &&
                          requester?.profileObjectId !== undefined
                        ) {
                          runTx(
                            buildAcceptFriendshipTransaction(
                              config,
                              request.id,
                              viewerProfileId,
                              requester.profileObjectId,
                            ),
                          );
                        }
                      }}
                    >
                      Accept
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Friends</h2>
        <div className="card-body">
          {friends.length === 0 ? (
            <p className="card-empty">No accepted friendships yet.</p>
          ) : (
            <ul className="invite-list">
              {friends.map((friend) => (
                <li key={friend.id} className="invite-row">
                  <span>{friend.displayName}</span>
                  <span className="invite-cap mono">
                    {friend.profileObjectId}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Potential friends</h2>
        <div className="card-body">
          {suggestions.length === 0 ? (
            <p className="card-empty">No friends-of-friends yet.</p>
          ) : (
            <ul className="invite-list">
              {suggestions.map((suggestion) => (
                <li key={suggestion.profile.id} className="invite-row">
                  <span>{suggestion.profile.displayName}</span>
                  <span className="invite-cap">
                    via {suggestion.via.length} friend
                    {suggestion.via.length === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function directFriends(
  state: AppState,
  viewer: UserId,
): readonly UserProfile[] {
  const friendIds = friendsOf(state, viewer);
  return [...friendIds]
    .map((id) => state.users.get(id))
    .filter((profile): profile is UserProfile => profile !== undefined)
    .sort((a, b) => a.handle.localeCompare(b.handle));
}

function friendSuggestions(
  state: AppState,
  viewer: UserId,
): readonly FriendSuggestion[] {
  const direct = friendsOf(state, viewer);
  const suggestions = new Map<UserId, Set<UserId>>();
  for (const friend of direct) {
    for (const candidate of friendsOf(state, friend)) {
      if (candidate === viewer || direct.has(candidate)) continue;
      const via = suggestions.get(candidate) ?? new Set<UserId>();
      via.add(friend);
      suggestions.set(candidate, via);
    }
  }
  const result: FriendSuggestion[] = [];
  for (const [id, via] of suggestions) {
    const profile = state.users.get(id);
    if (profile === undefined) continue;
    result.push({
      profile,
      via: [...via]
        .map((viaId) => state.users.get(viaId))
        .filter((p): p is UserProfile => p !== undefined),
    });
  }
  return result.sort(
    (a, b) =>
      b.via.length - a.via.length ||
      a.profile.handle.localeCompare(b.profile.handle),
  );
}

function friendsOf(state: AppState, profile: UserId): ReadonlySet<UserId> {
  const friends = new Set<UserId>();
  for (const friendship of state.friendships) {
    if (friendship.a === profile) friends.add(friendship.b);
    if (friendship.b === profile) friends.add(friendship.a);
  }
  return friends;
}

function resolveProfile(
  state: AppState,
  input: string,
): (UserProfile & { readonly profileObjectId: SuiObjectId }) | undefined {
  const cleaned = input.trim().replace(/^@/, "").toLowerCase();
  if (cleaned === "") return undefined;
  const profile = [...state.users.values()].find(
    (p) =>
      p.profileObjectId !== undefined && p.handle.toLowerCase() === cleaned,
  );
  return profile?.profileObjectId === undefined
    ? undefined
    : (profile as UserProfile & { readonly profileObjectId: SuiObjectId });
}
