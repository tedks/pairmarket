// Module pairmarket::market
//
// Binary pari-mutuel relationship-prediction market for the pairmarket MVP.
// See docs/design.md and .planning/subagents/move-object-model.md for the
// design rationale. This module is the Sui Move authority for escrow,
// lifecycle, and payout authorization. Privacy of relationship content,
// invitee discovery, and resolution evidence live off-chain (Walrus + SEAL
// + the wallet/api services).
//
// Invariants enforced by Move (cross-referenced to design.md "Move-enforced
// invariants"):
//   - Escrow conservation: every coin entering the market leaves only
//     through claim, refund, or fee withdrawal.
//   - Lifecycle monotonicity: state never moves backward.
//   - O(1) settlement: no function iterates over participants.
//   - Invite correctness: invite.market_id == market.id and
//     invite.grantee == ctx.sender.
//   - Position correctness: position.market_id == market.id and
//     position.owner == ctx.sender on claim and refund.
//   - Single use: invites are consumed once; positions claim once.
//   - Deadline correctness: only sui::Clock drives time checks.
//   - Outcome validity: YES / NO / INVALID only.
//   - Fee cap: copied fee_bps <= Config.max_fee_bps at creation.

module pairmarket::market {

    use std::option::{Self, Option};
    use std::vector;
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::object::{Self, ID, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};

    // ---- Lifecycle states ----

    const STATE_PROPOSED: u8 = 0;
    const STATE_TRADING: u8 = 1;
    const STATE_LOCKED: u8 = 2;
    const STATE_ATTESTATION_PENDING: u8 = 3;
    const STATE_CHALLENGE_WINDOW: u8 = 4;
    const STATE_DISPUTED: u8 = 5;
    const STATE_SETTLED: u8 = 6;
    const STATE_CANCELLED: u8 = 7;
    const STATE_EXPIRED: u8 = 8;

    // ---- Outcomes ----

    const OUTCOME_UNSET: u8 = 0;
    const OUTCOME_YES: u8 = 1;
    const OUTCOME_NO: u8 = 2;
    const OUTCOME_INVALID: u8 = 3;

    // ---- Errors ----

    const EWrongState: u64 = 1;
    const EWrongMarket: u64 = 2;
    const ENotInvitee: u64 = 3;
    const EInviteExpired: u64 = 4;
    const EStakeExceedsCap: u64 = 5;
    const EUnknownOutcome: u64 = 6;
    const ECloseDeadlinePassed: u64 = 7;
    const EAttestTooEarly: u64 = 8;
    const EChallengeWindowOpen: u64 = 9;
    const EChallengeWindowClosed: u64 = 10;
    const EDoubleClaim: u64 = 11;
    const EFeeCapExceeded: u64 = 12;
    const ENotSubject: u64 = 13;
    const ENotCommittee: u64 = 14;
    const EZeroStake: u64 = 15;
    const ENotConsented: u64 = 16;
    const EBothMustConsent: u64 = 17;
    const ENotCreator: u64 = 18;
    const ENotOwner: u64 = 19;
    const EMarketPaused: u64 = 20;
    const EAlreadyConsented: u64 = 21;
    const ENotWinner: u64 = 22;
    const ENotRefundable: u64 = 23;
    const ECommitteeEmpty: u64 = 24;
    const EZeroWinningShares: u64 = 25;
    const EAttestTooLate: u64 = 26;
    const EOverflow: u64 = 27;
    const ESameSubject: u64 = 28;
    const EBadDurations: u64 = 29;
    const EVerdictAlreadySet: u64 = 30;
    const EChallengerOnWinningSide: u64 = 31;
    const EFeeBpsAboveOneHundredPercent: u64 = 32;
    const EChallengeAlreadyOpen: u64 = 33;

    /// 100% in basis points. The fee cap can never exceed this regardless
    /// of `Config.max_fee_bps`.
    const BPS_DENOM: u64 = 10_000;
    const MAX_FEE_BPS_ABSOLUTE: u16 = 10_000;

    // ---- Configuration objects ----

    /// Package-wide configuration. Shared object created at deploy time.
    public struct Config has key {
        id: UID,
        max_fee_bps: u16,
        fee_recipient: address,
        paused: bool,
    }

    /// Admin authority for emergency cancellation and config mutation.
    public struct AdminCap has key { id: UID }

    // ---- Market and child objects ----

    /// Shared market object parameterized by collateral coin type `T`.
    public struct Market<phantom T> has key {
        id: UID,
        creator: address,
        // Off-chain content references. Opaque to Move.
        terms_hash: vector<u8>,
        metadata_ref: vector<u8>,
        subject_ref: vector<u8>,
        evidence_ref: Option<vector<u8>>,
        seal_policy_id: vector<u8>,
        policy_epoch: u32,
        // Lifecycle.
        state: u8,
        created_ms: u64,
        close_ms: u64,
        earliest_attest_ms: u64,
        resolution_deadline_ms: u64,
        challenge_window_ms: u64,
        dispute_deadline_ms: u64,
        challenge_opened_ms: Option<u64>,
        // Subjects and consent.
        subject_a: address,
        subject_b: address,
        consent_a: bool,
        consent_b: bool,
        // Attestation round-tracking; matched once both subjects agree.
        last_attestation_a: u8,
        last_attestation_b: u8,
        attestation_round: u32,
        matched_outcome: u8,
        // Dispute and committee.
        resolver_committee: vector<address>,
        challenger: Option<address>,
        committee_verdict: u8,
        // Fees and balances.
        fee_bps: u16,
        yes_pool: Balance<T>,
        no_pool: Balance<T>,
        fee_balance: Balance<T>,
        payout_pool: Balance<T>,
        // Share accounting.
        yes_shares: u64,
        no_shares: u64,
        winning_shares_remaining: u64,
        winning_outcome: u8,
    }

    /// Address-owned, non-transferable invite. Lacks `store`, so public
    /// transfer is impossible — only this module can mint or consume it.
    public struct InviteTicket has key {
        id: UID,
        market_id: ID,
        grantee: address,
        max_stake: u64,
        expires_ms: u64,
    }

    /// Address-owned, non-transferable position. Lacks `store`.
    public struct Position<phantom T> has key {
        id: UID,
        market_id: ID,
        owner: address,
        outcome: u8,
        stake: u64,
        shares: u64,
        claimed: bool,
    }

    // ---- Events ----

    public struct MarketCreated has copy, drop {
        market_id: ID,
        creator: address,
        subject_a: address,
        subject_b: address,
        fee_bps: u16,
        close_ms: u64,
    }

    public struct SubjectConsented has copy, drop {
        market_id: ID,
        subject: address,
    }

    public struct MarketOpened has copy, drop { market_id: ID }

    public struct InviteMinted has copy, drop {
        market_id: ID,
        grantee: address,
        max_stake: u64,
        expires_ms: u64,
    }

    public struct PositionOpened has copy, drop {
        market_id: ID,
        owner: address,
        outcome: u8,
        stake: u64,
        shares: u64,
    }

    public struct MarketLocked has copy, drop { market_id: ID }

    public struct AttestationSubmitted has copy, drop {
        market_id: ID,
        subject: address,
        outcome: u8,
        round: u32,
    }

    public struct AttestationMismatch has copy, drop {
        market_id: ID,
        round: u32,
    }

    public struct MatchedOutcome has copy, drop {
        market_id: ID,
        outcome: u8,
    }

    public struct ChallengeOpened has copy, drop {
        market_id: ID,
        challenger: address,
    }

    public struct CommitteeVerdict has copy, drop {
        market_id: ID,
        outcome: u8,
    }

    public struct MarketSettled has copy, drop {
        market_id: ID,
        winning_outcome: u8,
        payout_pool: u64,
        fee: u64,
    }

    public struct MarketCancelled has copy, drop { market_id: ID }

    public struct MarketExpired has copy, drop { market_id: ID }

    public struct Claimed has copy, drop {
        market_id: ID,
        owner: address,
        amount: u64,
    }

    public struct Refunded has copy, drop {
        market_id: ID,
        owner: address,
        amount: u64,
    }

    public struct FeesWithdrawn has copy, drop {
        market_id: ID,
        recipient: address,
        amount: u64,
    }

    // ---- Module initialization ----

    /// Called once at package publish. Creates an AdminCap (sent to the
    /// publisher) and a shared Config with conservative defaults.
    fun init(ctx: &mut TxContext) {
        let admin = AdminCap { id: object::new(ctx) };
        transfer::transfer(admin, tx_context::sender(ctx));

        let config = Config {
            id: object::new(ctx),
            max_fee_bps: 500, // 5% absolute ceiling for MVP
            fee_recipient: tx_context::sender(ctx),
            paused: false,
        };
        transfer::share_object(config);
    }

    // ---- Config mutation ----

    entry fun set_paused(
        _admin: &AdminCap,
        config: &mut Config,
        paused: bool,
    ) {
        config.paused = paused;
    }

    entry fun set_fee_recipient(
        _admin: &AdminCap,
        config: &mut Config,
        recipient: address,
    ) {
        config.fee_recipient = recipient;
    }

    entry fun set_max_fee_bps(
        _admin: &AdminCap,
        config: &mut Config,
        max_fee_bps: u16,
    ) {
        assert!(max_fee_bps <= MAX_FEE_BPS_ABSOLUTE, EFeeBpsAboveOneHundredPercent);
        config.max_fee_bps = max_fee_bps;
    }

    // ---- Market creation ----

    entry fun create_market<T>(
        terms_hash: vector<u8>,
        metadata_ref: vector<u8>,
        subject_ref: vector<u8>,
        seal_policy_id: vector<u8>,
        subject_a: address,
        subject_b: address,
        close_ms: u64,
        earliest_attest_ms: u64,
        resolution_deadline_ms: u64,
        challenge_window_ms: u64,
        dispute_deadline_ms: u64,
        fee_bps: u16,
        resolver_committee: vector<address>,
        config: &Config,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!config.paused, EMarketPaused);
        assert!(fee_bps <= config.max_fee_bps, EFeeCapExceeded);
        // Absolute bound: prevents `fee > gross` even if Config is misconfigured.
        assert!(fee_bps <= MAX_FEE_BPS_ABSOLUTE, EFeeBpsAboveOneHundredPercent);
        assert!(!vector::is_empty(&resolver_committee), ECommitteeEmpty);
        // Subjects must be distinct so the two-subject co-attestation cannot be
        // signed unilaterally by a single party.
        assert!(subject_a != subject_b, ESameSubject);

        let now = clock::timestamp_ms(clock);
        // Lightweight monotonicity check on the timing fields. Off-chain
        // services may add stronger checks; this is the minimum.
        assert!(close_ms >= now, ECloseDeadlinePassed);
        assert!(earliest_attest_ms >= close_ms, EAttestTooEarly);
        assert!(resolution_deadline_ms >= earliest_attest_ms, EAttestTooEarly);
        assert!(dispute_deadline_ms >= resolution_deadline_ms, EAttestTooEarly);
        // The challenge window must fit inside the resolution -> dispute span.
        // This prevents arithmetic overflow on `opened_ms + challenge_window_ms`
        // in `open_challenge`/`finalize` and keeps the dispute timeline coherent.
        assert!(
            challenge_window_ms <= dispute_deadline_ms - resolution_deadline_ms,
            EBadDurations,
        );

        let market = Market<T> {
            id: object::new(ctx),
            creator: tx_context::sender(ctx),
            terms_hash,
            metadata_ref,
            subject_ref,
            evidence_ref: option::none(),
            seal_policy_id,
            policy_epoch: 0,
            state: STATE_PROPOSED,
            created_ms: now,
            close_ms,
            earliest_attest_ms,
            resolution_deadline_ms,
            challenge_window_ms,
            dispute_deadline_ms,
            challenge_opened_ms: option::none(),
            subject_a,
            subject_b,
            consent_a: false,
            consent_b: false,
            last_attestation_a: OUTCOME_UNSET,
            last_attestation_b: OUTCOME_UNSET,
            attestation_round: 0,
            matched_outcome: OUTCOME_UNSET,
            resolver_committee,
            challenger: option::none(),
            committee_verdict: OUTCOME_UNSET,
            fee_bps,
            yes_pool: balance::zero<T>(),
            no_pool: balance::zero<T>(),
            fee_balance: balance::zero<T>(),
            payout_pool: balance::zero<T>(),
            yes_shares: 0,
            no_shares: 0,
            winning_shares_remaining: 0,
            winning_outcome: OUTCOME_UNSET,
        };

        let market_id = object::id(&market);
        event::emit(MarketCreated {
            market_id,
            creator: tx_context::sender(ctx),
            subject_a,
            subject_b,
            fee_bps,
            close_ms,
        });

        transfer::share_object(market);
    }

    // ---- Subject consent ----

    entry fun record_subject_consent<T>(
        market: &mut Market<T>,
        _clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(market.state == STATE_PROPOSED, EWrongState);
        let sender = tx_context::sender(ctx);
        let is_a = sender == market.subject_a;
        let is_b = sender == market.subject_b;
        assert!(is_a || is_b, ENotSubject);

        if (is_a) {
            assert!(!market.consent_a, EAlreadyConsented);
            market.consent_a = true;
        } else {
            assert!(!market.consent_b, EAlreadyConsented);
            market.consent_b = true;
        };

        event::emit(SubjectConsented { market_id: object::uid_to_inner(&market.id), subject: sender });

        if (market.consent_a && market.consent_b) {
            market.state = STATE_TRADING;
            event::emit(MarketOpened { market_id: object::uid_to_inner(&market.id) });
        };
    }

    // ---- Invite minting ----

    entry fun mint_invite<T>(
        market: &mut Market<T>,
        grantee: address,
        max_stake: u64,
        expires_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(market.state == STATE_TRADING, EWrongState);
        assert!(tx_context::sender(ctx) == market.creator, ENotCreator);
        let now = clock::timestamp_ms(clock);
        assert!(expires_ms > now, EInviteExpired);
        assert!(expires_ms <= market.close_ms, EInviteExpired);

        let invite = InviteTicket {
            id: object::new(ctx),
            market_id: object::uid_to_inner(&market.id),
            grantee,
            max_stake,
            expires_ms,
        };

        event::emit(InviteMinted {
            market_id: object::uid_to_inner(&market.id),
            grantee,
            max_stake,
            expires_ms,
        });

        transfer::transfer(invite, grantee);
    }

    // ---- Placing a wager ----

    entry fun place<T>(
        market: &mut Market<T>,
        invite: InviteTicket,
        stake: Coin<T>,
        outcome: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(market.state == STATE_TRADING, EWrongState);
        let now = clock::timestamp_ms(clock);
        assert!(now <= market.close_ms, ECloseDeadlinePassed);

        let sender = tx_context::sender(ctx);
        let market_id = object::uid_to_inner(&market.id);

        let InviteTicket {
            id: invite_id,
            market_id: invite_market_id,
            grantee,
            max_stake,
            expires_ms,
        } = invite;

        // Validate first, then consume. A Move abort rolls back the
        // object::delete below, so the ticket is only destroyed when the
        // wager actually succeeds — guaranteeing single-use without
        // burning the caller's ticket on a bad input.
        assert!(invite_market_id == market_id, EWrongMarket);
        assert!(grantee == sender, ENotInvitee);
        assert!(now < expires_ms, EInviteExpired);

        assert!(outcome == OUTCOME_YES || outcome == OUTCOME_NO, EUnknownOutcome);

        object::delete(invite_id);

        let amount = coin::value(&stake);
        assert!(amount > 0, EZeroStake);
        assert!(amount <= max_stake, EStakeExceedsCap);

        let stake_balance = coin::into_balance(stake);

        if (outcome == OUTCOME_YES) {
            balance::join(&mut market.yes_pool, stake_balance);
            market.yes_shares = market.yes_shares + amount;
        } else {
            balance::join(&mut market.no_pool, stake_balance);
            market.no_shares = market.no_shares + amount;
        };

        let position = Position<T> {
            id: object::new(ctx),
            market_id,
            owner: sender,
            outcome,
            stake: amount,
            shares: amount,
            claimed: false,
        };

        event::emit(PositionOpened {
            market_id,
            owner: sender,
            outcome,
            stake: amount,
            shares: amount,
        });

        transfer::transfer(position, sender);
    }

    // ---- Lifecycle transitions ----

    entry fun lock<T>(market: &mut Market<T>, clock: &Clock) {
        assert!(market.state == STATE_TRADING, EWrongState);
        let now = clock::timestamp_ms(clock);
        assert!(now >= market.close_ms, ECloseDeadlinePassed);
        market.state = STATE_LOCKED;
        event::emit(MarketLocked { market_id: object::uid_to_inner(&market.id) });
    }

    /// Move from Locked to AttestationPending once earliest attestation
    /// time has been reached. Idempotent within AttestationPending.
    fun ensure_attestation_phase<T>(market: &mut Market<T>, now: u64) {
        if (market.state == STATE_LOCKED) {
            assert!(now >= market.earliest_attest_ms, EAttestTooEarly);
            market.state = STATE_ATTESTATION_PENDING;
        };
    }

    entry fun submit_attestation<T>(
        market: &mut Market<T>,
        outcome: u8,
        evidence_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock::timestamp_ms(clock);
        // Auto-advance from Locked into AttestationPending on the first
        // valid attestation after earliest_attest_ms.
        if (market.state == STATE_TRADING) {
            // Allow a lazy lock-then-attest if both deadlines have passed.
            if (now >= market.close_ms) {
                market.state = STATE_LOCKED;
                event::emit(MarketLocked { market_id: object::uid_to_inner(&market.id) });
            };
        };
        ensure_attestation_phase(market, now);
        assert!(market.state == STATE_ATTESTATION_PENDING, EWrongState);
        assert!(now <= market.resolution_deadline_ms, EAttestTooLate);

        assert!(
            outcome == OUTCOME_YES || outcome == OUTCOME_NO || outcome == OUTCOME_INVALID,
            EUnknownOutcome,
        );

        let sender = tx_context::sender(ctx);
        let is_a = sender == market.subject_a;
        let is_b = sender == market.subject_b;
        assert!(is_a || is_b, ENotSubject);

        if (is_a) {
            market.last_attestation_a = outcome;
        } else {
            market.last_attestation_b = outcome;
        };

        // Attach the evidence hash to the market only when matched; for now
        // it is sufficient to drop it. Production may store per-attestation
        // dynamic fields; design.md says hash, not raw evidence.
        let _ = evidence_hash;

        event::emit(AttestationSubmitted {
            market_id: object::uid_to_inner(&market.id),
            subject: sender,
            outcome,
            round: market.attestation_round,
        });

        let a = market.last_attestation_a;
        let b = market.last_attestation_b;
        let both_present = (a != OUTCOME_UNSET) && (b != OUTCOME_UNSET);
        if (both_present) {
            if (a == b) {
                market.matched_outcome = a;
                market.state = STATE_CHALLENGE_WINDOW;
                market.challenge_opened_ms = option::some(now);
                event::emit(MatchedOutcome {
                    market_id: object::uid_to_inner(&market.id),
                    outcome: a,
                });
            } else {
                // Mismatch: reset round, keep state, request fresh attestations.
                market.last_attestation_a = OUTCOME_UNSET;
                market.last_attestation_b = OUTCOME_UNSET;
                market.attestation_round = market.attestation_round + 1;
                event::emit(AttestationMismatch {
                    market_id: object::uid_to_inner(&market.id),
                    round: market.attestation_round,
                });
            };
        };
    }

    /// A staked participant may bond and open a challenge during the
    /// challenge window. MVP records the challenger only; the bond and
    /// committee mechanics are left to a follow-up.
    entry fun open_challenge<T>(
        market: &mut Market<T>,
        position: &Position<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(market.state == STATE_CHALLENGE_WINDOW, EWrongState);
        // STATE_CHALLENGE_WINDOW already implies no prior challenge succeeded
        // (a successful open transitions to STATE_DISPUTED), but be explicit.
        assert!(option::is_none(&market.challenger), EChallengeAlreadyOpen);

        let market_id = object::uid_to_inner(&market.id);
        assert!(position.market_id == market_id, EWrongMarket);
        let sender = tx_context::sender(ctx);
        assert!(position.owner == sender, ENotOwner);
        // The challenger is contesting the matched outcome, so they cannot
        // hold a position on the side that would otherwise win. Subjects can
        // still challenge if they also hold a losing position.
        assert!(position.outcome != market.matched_outcome, EChallengerOnWinningSide);

        let now = clock::timestamp_ms(clock);
        let opened_ms = *option::borrow(&market.challenge_opened_ms);
        assert!(now <= opened_ms + market.challenge_window_ms, EChallengeWindowClosed);

        market.challenger = option::some(sender);
        market.state = STATE_DISPUTED;
        event::emit(ChallengeOpened { market_id, challenger: sender });
    }

    entry fun submit_committee_verdict<T>(
        market: &mut Market<T>,
        outcome: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(market.state == STATE_DISPUTED, EWrongState);
        // First-verdict-wins for MVP. A 3-of-5 threshold scheme will replace
        // this; the design issue is pm-resolution-dispute-committee.
        assert!(market.committee_verdict == OUTCOME_UNSET, EVerdictAlreadySet);
        assert!(
            outcome == OUTCOME_YES || outcome == OUTCOME_NO || outcome == OUTCOME_INVALID,
            EUnknownOutcome,
        );

        let sender = tx_context::sender(ctx);
        assert!(committee_contains(&market.resolver_committee, sender), ENotCommittee);

        let now = clock::timestamp_ms(clock);
        assert!(now <= market.dispute_deadline_ms, EChallengeWindowClosed);

        // MVP: any committee member's verdict stands once submitted. The
        // n-of-m threshold belongs to the dispute committee design and can
        // be added without changing the object model.
        market.committee_verdict = outcome;
        market.matched_outcome = outcome;
        event::emit(CommitteeVerdict {
            market_id: object::uid_to_inner(&market.id),
            outcome,
        });
    }

    /// Finalize after the challenge window or after a committee verdict.
    /// Also expires markets stranded because subjects never attested or
    /// never matched: Trading/Locked/AttestationPending past the resolution
    /// deadline all route to refund-only `STATE_EXPIRED`. This prevents
    /// participant escrow from being held indefinitely by an inactive
    /// subject pair and keeps refund as the only available payout.
    entry fun finalize<T>(market: &mut Market<T>, clock: &Clock) {
        let now = clock::timestamp_ms(clock);
        let market_id = object::uid_to_inner(&market.id);

        // Stranded pre-attestation: Trading/Locked/AttestationPending after
        // the resolution deadline expire to refund-only.
        if (
            market.state == STATE_TRADING ||
            market.state == STATE_LOCKED ||
            market.state == STATE_ATTESTATION_PENDING
        ) {
            assert!(now > market.resolution_deadline_ms, EAttestTooEarly);
            market.state = STATE_EXPIRED;
            event::emit(MarketExpired { market_id });
            return
        };

        // Disputed without a verdict by the hard deadline: refund as INVALID.
        if (market.state == STATE_DISPUTED) {
            if (market.committee_verdict == OUTCOME_UNSET) {
                assert!(now > market.dispute_deadline_ms, EChallengeWindowOpen);
                market.matched_outcome = OUTCOME_INVALID;
                market.state = STATE_EXPIRED;
                event::emit(MarketExpired { market_id });
                return
            };
            // Verdict in: proceed to settlement below.
            settle_from_matched(market, now);
            return
        };

        // Happy path: challenge window must have elapsed.
        assert!(market.state == STATE_CHALLENGE_WINDOW, EWrongState);
        let opened_ms = *option::borrow(&market.challenge_opened_ms);
        assert!(now > opened_ms + market.challenge_window_ms, EChallengeWindowOpen);
        settle_from_matched(market, now);
    }

    fun settle_from_matched<T>(market: &mut Market<T>, _now: u64) {
        let outcome = market.matched_outcome;
        let market_id = object::uid_to_inner(&market.id);

        if (outcome == OUTCOME_INVALID) {
            // INVALID routes to refund-only via STATE_EXPIRED semantics.
            // We use STATE_EXPIRED so refund() is the only payout path.
            market.state = STATE_EXPIRED;
            event::emit(MarketExpired { market_id });
            return
        };

        // YES or NO settlement: take fee on gross escrow, build payout pool.
        let yes_value = balance::value(&market.yes_pool);
        let no_value = balance::value(&market.no_pool);
        let gross = yes_value + no_value;

        // If winning side has no shares, treat as INVALID and refund.
        let winning_side_has_shares = if (outcome == OUTCOME_YES) {
            market.yes_shares > 0
        } else {
            market.no_shares > 0
        };
        if (!winning_side_has_shares) {
            market.matched_outcome = OUTCOME_INVALID;
            market.state = STATE_EXPIRED;
            event::emit(MarketExpired { market_id });
            return
        };

        let fee = mul_div_u64(gross, (market.fee_bps as u64), 10_000);
        // Drain both pools into a working balance, take fee out of it.
        let yes_pool = balance::withdraw_all(&mut market.yes_pool);
        let no_pool = balance::withdraw_all(&mut market.no_pool);
        let mut combined = yes_pool;
        balance::join(&mut combined, no_pool);

        let fee_balance = balance::split(&mut combined, fee);
        balance::join(&mut market.fee_balance, fee_balance);

        balance::join(&mut market.payout_pool, combined);

        market.winning_outcome = outcome;
        market.winning_shares_remaining = if (outcome == OUTCOME_YES) {
            market.yes_shares
        } else {
            market.no_shares
        };
        market.state = STATE_SETTLED;

        event::emit(MarketSettled {
            market_id,
            winning_outcome: outcome,
            payout_pool: balance::value(&market.payout_pool),
            fee,
        });
    }

    // ---- Claim and refund ----

    entry fun claim<T>(
        market: &mut Market<T>,
        position: &mut Position<T>,
        ctx: &mut TxContext,
    ) {
        assert!(market.state == STATE_SETTLED, EWrongState);
        let sender = tx_context::sender(ctx);
        assert!(position.owner == sender, ENotOwner);
        assert!(position.market_id == object::uid_to_inner(&market.id), EWrongMarket);
        assert!(!position.claimed, EDoubleClaim);
        assert!(position.outcome == market.winning_outcome, ENotWinner);
        assert!(market.winning_shares_remaining >= position.shares, EZeroWinningShares);

        // Mutate first, transfer coins second.
        position.claimed = true;

        let pool_value = balance::value(&market.payout_pool);
        let remaining = market.winning_shares_remaining;
        let payout = mul_div_u64(pool_value, position.shares, remaining);

        market.winning_shares_remaining = remaining - position.shares;

        let payout_balance = balance::split(&mut market.payout_pool, payout);
        let payout_coin = coin::from_balance(payout_balance, ctx);

        event::emit(Claimed {
            market_id: object::uid_to_inner(&market.id),
            owner: sender,
            amount: payout,
        });

        transfer::public_transfer(payout_coin, sender);
    }

    entry fun refund<T>(
        market: &mut Market<T>,
        position: &mut Position<T>,
        ctx: &mut TxContext,
    ) {
        let refundable =
            market.state == STATE_CANCELLED ||
            market.state == STATE_EXPIRED;
        assert!(refundable, ENotRefundable);

        let sender = tx_context::sender(ctx);
        assert!(position.owner == sender, ENotOwner);
        assert!(position.market_id == object::uid_to_inner(&market.id), EWrongMarket);
        assert!(!position.claimed, EDoubleClaim);

        position.claimed = true;

        let amount = position.stake;
        let source = if (position.outcome == OUTCOME_YES) {
            &mut market.yes_pool
        } else {
            &mut market.no_pool
        };
        let refund_balance = balance::split(source, amount);
        let refund_coin = coin::from_balance(refund_balance, ctx);

        event::emit(Refunded {
            market_id: object::uid_to_inner(&market.id),
            owner: sender,
            amount,
        });

        transfer::public_transfer(refund_coin, sender);
    }

    // ---- Admin cancellation ----

    entry fun cancel<T>(
        market: &mut Market<T>,
        _admin: &AdminCap,
        _clock: &Clock,
    ) {
        // Allowed from any pre-settlement, pre-cancellation state.
        let s = market.state;
        let allowed =
            s == STATE_PROPOSED ||
            s == STATE_TRADING ||
            s == STATE_LOCKED ||
            s == STATE_ATTESTATION_PENDING ||
            s == STATE_CHALLENGE_WINDOW ||
            s == STATE_DISPUTED;
        assert!(allowed, EWrongState);
        market.state = STATE_CANCELLED;
        event::emit(MarketCancelled { market_id: object::uid_to_inner(&market.id) });
    }

    // ---- Fee withdrawal ----

    entry fun withdraw_fees<T>(
        market: &mut Market<T>,
        config: &Config,
        ctx: &mut TxContext,
    ) {
        assert!(market.state == STATE_SETTLED, EWrongState);
        let amount = balance::value(&market.fee_balance);
        if (amount == 0) { return };
        let fee_balance = balance::withdraw_all(&mut market.fee_balance);
        let fee_coin = coin::from_balance(fee_balance, ctx);
        event::emit(FeesWithdrawn {
            market_id: object::uid_to_inner(&market.id),
            recipient: config.fee_recipient,
            amount,
        });
        transfer::public_transfer(fee_coin, config.fee_recipient);
    }

    // ---- Helpers ----

    /// Widening multiply-divide that aborts if the divisor is zero or the
    /// result exceeds u64.
    fun mul_div_u64(a: u64, b: u64, c: u64): u64 {
        assert!(c > 0, EZeroWinningShares);
        let wide = (a as u128) * (b as u128) / (c as u128);
        assert!(wide <= (18_446_744_073_709_551_615u128), EOverflow);
        (wide as u64)
    }

    fun committee_contains(committee: &vector<address>, who: address): bool {
        let mut i = 0;
        let n = vector::length(committee);
        while (i < n) {
            if (*vector::borrow(committee, i) == who) {
                return true
            };
            i = i + 1;
        };
        false
    }

    // ---- Read-only accessors used by tests and off-chain indexers ----

    public fun state<T>(m: &Market<T>): u8 { m.state }
    public fun winning_outcome<T>(m: &Market<T>): u8 { m.winning_outcome }
    public fun yes_pool_value<T>(m: &Market<T>): u64 { balance::value(&m.yes_pool) }
    public fun no_pool_value<T>(m: &Market<T>): u64 { balance::value(&m.no_pool) }
    public fun payout_pool_value<T>(m: &Market<T>): u64 { balance::value(&m.payout_pool) }
    public fun fee_balance_value<T>(m: &Market<T>): u64 { balance::value(&m.fee_balance) }
    public fun winning_shares_remaining<T>(m: &Market<T>): u64 { m.winning_shares_remaining }
    public fun position_claimed<T>(p: &Position<T>): bool { p.claimed }
    public fun position_shares<T>(p: &Position<T>): u64 { p.shares }
    public fun position_outcome<T>(p: &Position<T>): u8 { p.outcome }

    // ---- Test-only constructors ----

    #[test_only]
    public fun test_init(ctx: &mut TxContext) {
        init(ctx);
    }

    #[test_only]
    public fun outcome_yes(): u8 { OUTCOME_YES }
    #[test_only]
    public fun outcome_no(): u8 { OUTCOME_NO }
    #[test_only]
    public fun outcome_invalid(): u8 { OUTCOME_INVALID }
    #[test_only]
    public fun state_trading(): u8 { STATE_TRADING }
    #[test_only]
    public fun state_settled(): u8 { STATE_SETTLED }
    #[test_only]
    public fun state_cancelled(): u8 { STATE_CANCELLED }
    #[test_only]
    public fun state_expired(): u8 { STATE_EXPIRED }
}
