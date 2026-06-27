import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { UserId } from "@pairmarket/core";
import { parseMistAmount, parseUnixMs } from "@pairmarket/core";
import type { Route } from "../App.tsx";
import type { AppState, OperationalizationKind } from "../types.ts";
import { createMarketDraft } from "../mock/intents.ts";
import { setState } from "../mock/store.ts";

type Props = {
  readonly state: AppState;
  readonly setRoute: (r: Route) => void;
};

type OpKindLabel = OperationalizationKind["kind"];

export function CreateMarket({ state, setRoute }: Props): JSX.Element {
  const others = useMemo(
    () => [...state.users.values()].filter((u) => u.id !== state.viewer),
    [state.users, state.viewer],
  );
  const [title, setTitle] = useState("Will X and Y last 3 dates?");
  const [prompt, setPrompt] = useState(
    "Three dates means three meetings of at least 90 minutes with mutual intent.",
  );
  const [subjectA, setSubjectA] = useState<UserId | "">(others[0]?.id ?? "");
  const [subjectB, setSubjectB] = useState<UserId | "">(others[1]?.id ?? "");
  const [opKind, setOpKind] = useState<OpKindLabel>("lasts-n-dates");
  const [nDates, setNDates] = useState(3);
  const [deadlineDays, setDeadlineDays] = useState(21);
  const [invitees, setInvitees] = useState<Set<UserId>>(new Set());
  const [stakeCapSui, setStakeCapSui] = useState(2);
  const [err, setErr] = useState<string | undefined>(undefined);

  const canSubmit =
    title.trim().length > 0 &&
    subjectA !== "" &&
    subjectB !== "" &&
    subjectA !== subjectB &&
    deadlineDays > 0;

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
          try {
            const deadlineMs = parseUnixMs(
              (state.nowMs as number) + deadlineDays * 86_400_000,
            );
            const op: OperationalizationKind =
              opKind === "lasts-n-dates"
                ? { kind: "lasts-n-dates", n: nDates }
                : opKind === "together-by-date"
                  ? { kind: "together-by-date", deadlineMs }
                  : { kind: "meet-by-date", deadlineMs };
            const next = createMarketDraft(state, {
              title,
              prompt,
              subjectA: subjectA as UserId,
              subjectB: subjectB as UserId,
              operationalization: op,
              resolutionDeadlineMs: deadlineMs,
              challengeWindowMs: 2 * 86_400_000,
              invitees: [...invitees].map((id) => ({
                invitee: id,
                maxStakeMist: parseMistAmount(
                  BigInt(Math.round(stakeCapSui * 1_000_000_000)),
                ),
              })),
            });
            setState(next);
            // Navigate to the newly created market: it's the latest.
            const latest = [...next.markets.values()].at(-1);
            if (latest) setRoute({ kind: "market", id: latest.id });
            else setRoute({ kind: "markets" });
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          }
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
            <select
              value={subjectA}
              onChange={(e) => setSubjectA(e.target.value as UserId)}
              data-testid="create-subject-a"
              required
            >
              {others.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} · @{u.handle}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Subject B">
            <select
              value={subjectB}
              onChange={(e) => setSubjectB(e.target.value as UserId)}
              data-testid="create-subject-b"
              required
            >
              {others
                .filter((u) => u.id !== subjectA)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} · @{u.handle}
                  </option>
                ))}
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
            <Field label="Deadline (days)">
              <input
                type="number"
                min={1}
                max={365}
                value={deadlineDays}
                onChange={(e) => setDeadlineDays(Number(e.target.value))}
              />
            </Field>
          )}
          <Field label="Resolution window (days)">
            <input
              type="number"
              min={1}
              max={365}
              value={deadlineDays}
              onChange={(e) => setDeadlineDays(Number(e.target.value))}
              data-testid="create-deadline-days"
            />
          </Field>
          <Field label="Stake cap per invitee (SUI)">
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={stakeCapSui}
              onChange={(e) => setStakeCapSui(Number(e.target.value))}
            />
          </Field>
        </div>

        <fieldset className="invitee-fieldset">
          <legend>Invitees</legend>
          <div className="invitee-grid">
            {others
              .filter((u) => u.id !== subjectA && u.id !== subjectB)
              .map((u) => {
                const checked = invitees.has(u.id);
                return (
                  <label key={u.id} className="invitee-chip">
                    <input
                      type="checkbox"
                      checked={checked}
                      data-testid={`create-invitee-${u.handle}`}
                      onChange={(e) => {
                        const next = new Set(invitees);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        setInvitees(next);
                      }}
                    />
                    {u.displayName}
                  </label>
                );
              })}
          </div>
        </fieldset>

        {err ? <p className="form-error">{err}</p> : null}

        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setRoute({ kind: "markets" })}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canSubmit}
            data-testid="create-submit"
          >
            Create draft
          </button>
        </div>
      </form>
    </section>
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
