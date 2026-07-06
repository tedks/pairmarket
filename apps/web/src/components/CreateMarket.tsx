import type { JSX } from "react";
import { useState } from "react";
import { parseSuiObjectId, parseUnixMs } from "@pairmarket/core";
import type { Route } from "../App.tsx";
import type {
  AppState,
  OperationalizationKind,
  UserProfile,
  VisibilityScope,
} from "../types.ts";
import { requirePairmarketMoveConfig } from "../sui/config.ts";
import {
  buildCreateMarketTransaction,
  findCreatedMarketId,
} from "../sui/market.ts";
import { saveLocalMarketMetadata } from "../sui/metadata.ts";
import { useExecuteSuiTransaction } from "../sui/execute.ts";

type Props = {
  readonly state: AppState;
  readonly setRoute: (r: Route) => void;
  readonly refresh: () => void;
};

type OpKindLabel = OperationalizationKind["kind"];

export function CreateMarket({ state, setRoute, refresh }: Props): JSX.Element {
  const execute = useExecuteSuiTransaction();
  const viewerProfile = state.users.get(state.viewer);
  const [title, setTitle] = useState("Will X and Y last 3 dates?");
  const [prompt, setPrompt] = useState(
    "Three dates means three meetings of at least 90 minutes with mutual intent.",
  );
  const [subjectA, setSubjectA] = useState("");
  const [subjectB, setSubjectB] = useState("");
  const [visibility, setVisibility] = useState<VisibilityScope>("friends");
  const [opKind, setOpKind] = useState<OpKindLabel>("lasts-n-dates");
  const [nDates, setNDates] = useState(3);
  const [closeDays, setCloseDays] = useState(7);
  const [resolutionDeadlineDays, setResolutionDeadlineDays] = useState(21);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const resolvedSubjectA = resolveFriendProfile(state, subjectA);
  const resolvedSubjectB = resolveFriendProfile(state, subjectB);
  const viewerProfileId = viewerProfile?.profileObjectId;
  const deadlineOrderError =
    closeDays < resolutionDeadlineDays
      ? undefined
      : "Close deadline must be before the resolution deadline.";

  const canSubmit =
    viewerProfileId !== undefined &&
    title.trim().length > 0 &&
    resolvedSubjectA !== undefined &&
    resolvedSubjectB !== undefined &&
    resolvedSubjectA.profileObjectId !== resolvedSubjectB.profileObjectId &&
    resolutionDeadlineDays > 0 &&
    closeDays > 0 &&
    deadlineOrderError === undefined &&
    !submitting;

  return (
    <section className="create-market">
      <header className="market-list-head">
        <h1>New market</h1>
        <p className="market-list-sub">
          Drafts go to "Awaiting consent" until both subjects accept.
        </p>
      </header>

      <form
        className="create-form"
        onSubmit={(e) => {
          e.preventDefault();
          setErr(undefined);
          if (!canSubmit) return;
          setSubmitting(true);
          void (async () => {
            try {
              const config = requirePairmarketMoveConfig();
              const now = Date.now();
              const challengeWindowMs = 2 * 86_400_000;
              const closeMs = now + closeDays * 86_400_000;
              const resolutionDeadlineMs =
                now + resolutionDeadlineDays * 86_400_000;
              const operationalization: OperationalizationKind =
                opKind === "lasts-n-dates"
                  ? { kind: "lasts-n-dates", n: nDates }
                  : opKind === "together-by-date"
                    ? {
                        kind: "together-by-date",
                        deadlineMs: parseUnixMs(closeMs),
                      }
                    : {
                        kind: "meet-by-date",
                        deadlineMs: parseUnixMs(closeMs),
                      };
              const tx = await buildCreateMarketTransaction({
                config,
                creatorProfile: viewerProfileId,
                operationalization,
                visibility,
                title,
                prompt,
                subjectAProfile: resolvedSubjectA.profileObjectId,
                subjectBProfile: resolvedSubjectB.profileObjectId,
                closeMs,
                earliestAttestMs: closeMs,
                resolutionDeadlineMs,
                challengeWindowMs,
                disputeDeadlineMs: resolutionDeadlineMs + challengeWindowMs,
                feeBps: 0,
                resolverCommittee: [viewerProfileId],
              });
              const result = await execute(tx);
              const marketId = findCreatedMarketId(result);
              if (marketId !== undefined) {
                saveLocalMarketMetadata(config.packageId, marketId, {
                  title,
                  prompt,
                  operationalization,
                });
                refresh();
                setRoute({ kind: "market", id: marketId });
              } else {
                refresh();
                setRoute({ kind: "markets", filter: "all" });
              }
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setSubmitting(false);
            }
          })();
        }}
      >
        <div className="form-grid">
          <Field label="Title">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="create-title"
              required
            />
          </Field>
          <Field label="Prompt">
            <textarea
              value={prompt}
              rows={3}
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="create-prompt"
            />
          </Field>

          <Field label="Subject A">
            <input
              type="text"
              value={subjectA}
              onChange={(e) => setSubjectA(e.target.value)}
              data-testid="create-subject-a"
              placeholder="@heyellieday"
              required
            />
          </Field>
          <Field label="Subject B">
            <input
              type="text"
              value={subjectB}
              onChange={(e) => setSubjectB(e.target.value)}
              data-testid="create-subject-b"
              placeholder="@tedks"
              required
            />
          </Field>

          <Field label="Visibility">
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as VisibilityScope)}
              data-testid="create-visibility"
            >
              <option value="friends">Creator's friends only</option>
              <option value="friends-of-friends">
                Creator's friends + friends of friends
              </option>
              <option value="public">Public</option>
            </select>
          </Field>

          <Field label="Operationalization">
            <select
              value={opKind}
              onChange={(e) => setOpKind(e.target.value as OpKindLabel)}
              data-testid="create-op-kind"
            >
              <option value="lasts-n-dates">Lasts N dates</option>
              <option value="together-by-date">Together by date</option>
              <option value="meet-by-date">Meet by date</option>
            </select>
          </Field>
          {opKind === "lasts-n-dates" ? (
            <Field label="N dates">
              <input
                type="number"
                min={1}
                max={20}
                value={nDates}
                onChange={(e) => setNDates(Number(e.target.value))}
              />
            </Field>
          ) : (
            <Field label="Close deadline (days)">
              <input
                type="number"
                min={1}
                max={365}
                value={closeDays}
                onChange={(e) => setCloseDays(Number(e.target.value))}
                data-testid="create-op-deadline-days"
              />
            </Field>
          )}
          <Field label="Resolution deadline (days)">
            <input
              type="number"
              min={1}
              max={365}
              value={resolutionDeadlineDays}
              onChange={(e) =>
                setResolutionDeadlineDays(Number(e.target.value))
              }
              data-testid="create-deadline-days"
            />
          </Field>
        </div>

        {deadlineOrderError ? (
          <p className="form-error" data-testid="create-deadline-error">
            {deadlineOrderError}
          </p>
        ) : null}
        {resolvedSubjectA !== undefined || subjectA.trim() === "" ? null : (
          <p className="form-error">Subject A must be a known friend handle.</p>
        )}
        {resolvedSubjectB !== undefined || subjectB.trim() === "" ? null : (
          <p className="form-error">Subject B must be a known friend handle.</p>
        )}
        {viewerProfileId === undefined ? (
          <p className="form-error">
            Create a profile object before creating a market.
          </p>
        ) : null}
        {err ? <p className="form-error">{err}</p> : null}

        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setRoute({ kind: "markets", filter: "all" })}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canSubmit}
            data-testid="create-submit"
          >
            {submitting ? "Creating..." : "Create market"}
          </button>
        </div>
      </form>
    </section>
  );
}

function resolveFriendProfile(
  state: AppState,
  input: string,
):
  | (UserProfile & {
      readonly profileObjectId: NonNullable<UserProfile["profileObjectId"]>;
    })
  | undefined {
  const cleaned = input.trim().replace(/^@/, "").toLowerCase();
  if (cleaned === "") return undefined;
  const byHandle = [...state.users.values()].find(
    (profile) =>
      profile.profileObjectId !== undefined &&
      profile.handle.toLowerCase() === cleaned,
  );
  if (
    byHandle?.profileObjectId !== undefined &&
    isViewerFriend(state, byHandle)
  ) {
    return byHandle as UserProfile & {
      readonly profileObjectId: NonNullable<UserProfile["profileObjectId"]>;
    };
  }
  try {
    const objectId = parseSuiObjectId(input.trim());
    const byId = [...state.users.values()].find(
      (profile) => profile.profileObjectId === objectId,
    );
    return byId?.profileObjectId === undefined || !isViewerFriend(state, byId)
      ? undefined
      : (byId as UserProfile & {
          readonly profileObjectId: NonNullable<UserProfile["profileObjectId"]>;
        });
  } catch {
    return undefined;
  }
}

function isViewerFriend(state: AppState, profile: UserProfile): boolean {
  return state.friendships.some(
    (friendship) =>
      (friendship.a === state.viewer && friendship.b === profile.id) ||
      (friendship.b === state.viewer && friendship.a === profile.id),
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
