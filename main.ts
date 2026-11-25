// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins
//
// Two-phase "lottery + guardrail sprint" bot for the agent-fun/replay/v2 harness.
// The replay is a 6-hour pump.fun forward window, ranked by hourly Sharpe ratio,
// with a minimum bar of a round trip of at least 0.01 SOL on at least 20 distinct
// mints and a maximum drawdown of 50%.
//
// Why this shape (offline research on the dev window, harness-faithful sims):
// most coins drift down (median coin ends ~-6% vs its first price) and chasing
// momentum or dips loses; the only shape that held up is the "lottery ticket":
// buy a coin once, early, for a small fixed stake, take profit at +100%, never
// stop out, and let the rare migrator pay for the tickets. A no-exit variant
// scores positive on the full dev window but only closes 8 round trips, so it
// misses the 20-mint bar. Hence two phases:
//
//   Core mode (from the first batch): buy once per coin when its real SOL
//   reserves cross 2 SOL, stake 0.02 SOL, no rebuy. Exit at take-profit +100%
//   (sell all), or a stale exit after 36,000 slots held (~4h) when the return
//   is still under +50%. The harness force-closes a position when its curve
//   completes, so a sell is never sent for a position that is gone.
//
//   Sprint mode (guardrail): once 36,000 slots have elapsed from the first
//   batch's slot AND fewer than 20 distinct mints have completed a round trip,
//   buys switch to a 0.01 SOL stake with a 3,000-slot (~20 min) hold cap, then
//   sell. When 20 distinct mints have completed round trips, sprint turns off
//   and core resumes.
//
// Determinism: entries run twice and the two action logs must match byte for
// byte, so this bot reads no clock, no environment and no Math.random. Every
// decision comes from the hello message, the batch and the slot; price
// comparisons use BigInt cross-multiplication. Randomness is never needed.
//
// The words hello, batch, orders and slot: the harness speaks hello once, then
// one batch per slot, and this bot answers each batch with its orders.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
/** A coin becomes buyable once its real SOL reserves reach 2 SOL. */
const ENTRY_REAL_RESERVES = 2n * SOL;
/** Core stake: 0.02 SOL (exactly the 100 bps size cap at 2 SOL of reserves). */
const CORE_STAKE = SOL / 50n;
/** Sprint stake: 0.01 SOL (still the minimum round-trip size). */
const SPRINT_STAKE = SOL / 100n;
/** Slippage left wide open, like the house baseline. */
const MAX_SLIPPAGE_BPS = 10_000;
/** Core stale exit: sell after this many slots held when return < +50%. */
const CORE_STALE_SLOTS = 36_000;
/** Sprint hold cap: sell after this many slots held, whatever the price. */
const SPRINT_HOLD_SLOTS = 3_000;
/** Sprint starts this many slots after the first batch's slot. */
const SPRINT_START_SLOTS = 36_000;
/** Sprint runs until this many distinct mints have completed a round trip. */
const SPRINT_TARGET_MINTS = 20;
/** Slots to wait before retrying a coin whose buy was rejected or failed. */
const BUY_RETRY_COOLDOWN_SLOTS = 600;

interface EntryInfo {
  /** Slot the buy fill resolved at. */
  entrySlot: number;
  /** True when the buy was decided while sprint mode was on. */
  sprint: boolean;
}

interface PendingBuy {
  mint: string;
  sprint: boolean;
}

/** Coins seen via CreateEvent and not yet bought. */
const candidates = new Set<string>();
/** Coins with a filled buy (one buy per coin, never rebuy). */
const bought = new Set<string>();
/** Coins with a buy order in flight. */
const buyPendingMints = new Set<string>();
/** client_id -> the buy it belongs to, for matching fills. */
const pendingBuys = new Map<string, PendingBuy>();
/** mint -> slot before which a rejected/failed buy may not be retried. */
const buyCooldownUntil = new Map<string, number>();
/** mint -> entry slot and mode of the open position. */
const openEntries = new Map<string, EntryInfo>();
/** Distinct mints with at least one completed round trip (sell fill). */
const completedMints = new Set<string>();

/** Slot of the first batch; null until the first batch arrives. */
let t0: number | null = null;

/** Fold this batch's fills into the bot's books before deciding orders. */
function applyFills(state: BotState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.side === 'buy') {
      const rec = pendingBuys.get(fill.client_id);
      if (rec === undefined) continue;
      pendingBuys.delete(fill.client_id);
      buyPendingMints.delete(rec.mint);
      if (fill.status === 'filled') {
        bought.add(rec.mint);
        candidates.delete(rec.mint);
        openEntries.set(rec.mint, { entrySlot: fill.slot, sprint: rec.sprint });
      } else {
        // Rejected or failed: the coin is NOT decided. Retry after a cooldown.
        buyCooldownUntil.set(rec.mint, state.slot + BUY_RETRY_COOLDOWN_SLOTS);
      }
    } else if (fill.side === 'sell' && fill.status === 'filled') {
      // Counts our own sells and the harness's closes (_complete_, _flatten_,
      // _writeoff_): either way the round trip on this mint is complete.
      completedMints.add(fill.mint);
      openEntries.delete(fill.mint);
    }
  }
  // Drop bookkeeping for positions the harness closed without a fill we saw.
  for (const mint of [...openEntries.keys()]) {
    if (!state.positions.has(mint) && !buyPendingMints.has(mint)) openEntries.delete(mint);
  }
}

/**
 * Current value of a holding in lamports, as a fraction: value = tokens *
 * virtual_quote_reserves / virtual_token_reserves. Returns null when the curve
 * is unknown, so the caller can fall back to hold-time rules only.
 */
function valueNumerator(
  state: BotState,
  mint: string,
  tokenAmount: bigint,
): { num: bigint; den: bigint } | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  return {
    num: tokenAmount * curve.virtual_quote_reserves,
    den: curve.virtual_token_reserves,
  };
}

/** True when value >= 2 * cost (take-profit +100%), by cross-multiplication. */
function atTakeProfit(value: { num: bigint; den: bigint }, costLamports: bigint): boolean {
  return value.num >= 2n * costLamports * value.den;
}

/** True when value < 1.5 * cost (return under +50%), by cross-multiplication. */
function belowHalfGain(value: { num: bigint; den: bigint }, costLamports: bigint): boolean {
  return 2n * value.num < 3n * costLamports * value.den;
}

await runBot({
  onBatch(state, batch) {
    if (t0 === null) t0 = state.slot;
    applyFills(state, batch);

    const sprint =
      state.slot - t0 >= SPRINT_START_SLOTS && completedMints.size < SPRINT_TARGET_MINTS;
    const stake = sprint ? SPRINT_STAKE : CORE_STAKE;
    const tx = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;
    let free = state.freeCashLamports();
    const orders: OrderInput[] = [];

    // Sells first: exits matter more than new entries, and each sell also pays
    // a transaction fee, so reserve cash for them before buying.
    const pendingSellMints = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSellMints.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (pendingSellMints.has(mint)) continue;
      const info = openEntries.get(mint);
      const held = state.slot - (info?.entrySlot ?? state.slot);
      const wasSprint = info?.sprint ?? false;
      const value = valueNumerator(state, mint, holding.token_amount);
      let sell = false;
      if (value !== null && atTakeProfit(value, holding.cost_lamports)) {
        sell = true;
      } else if (wasSprint && held >= SPRINT_HOLD_SLOTS) {
        sell = true;
      } else if (
        !wasSprint &&
        held >= CORE_STALE_SLOTS &&
        (value === null || belowHalfGain(value, holding.cost_lamports))
      ) {
        sell = true;
      }
      if (!sell) continue;
      if (free < tx) continue;
      orders.push({
        side: 'sell',
        client_id: state.clientId(),
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      free -= tx;
    }

    // Buys: one per coin, when real reserves cross 2 SOL. A coin stays a
    // candidate until its buy fills; a rejected or failed buy only cools it
    // down, it never decides it.
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') candidates.add(e.mint);
      if (e.event === 'CompleteEvent') candidates.delete(e.mint);
      if (!candidates.has(e.mint)) continue;
      if (bought.has(e.mint) || buyPendingMints.has(e.mint)) continue;
      const cooldown = buyCooldownUntil.get(e.mint);
      if (cooldown !== undefined && state.slot < cooldown) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        if (curve?.complete) candidates.delete(e.mint);
        continue;
      }
      if (curve.real_quote_reserves < ENTRY_REAL_RESERVES) continue;
      if (state.maxBuyLamports(e.mint) < stake) continue;
      if (orders.length >= maxOrders || slots <= 0 || free < stake + tx) continue;
      const clientId = state.clientId();
      orders.push({
        side: 'buy',
        client_id: clientId,
        mint: e.mint,
        quote_lamports: stake,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingBuys.set(clientId, { mint: e.mint, sprint });
      buyPendingMints.add(e.mint);
      free -= stake + tx;
      slots -= 1;
    }
    return orders;
  },
});
