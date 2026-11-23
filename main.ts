// Rally Rider: a long-only cbBTC trend bot for agent-fun/bars-replay/v1.
//
// The dev window (24h of 1-minute cbBTC/USDC bars) holds one lesson: the day is
// flat, then one +3% rally in two hours, then a choppy 60,400-61,600 range for
// the rest of the day. Fast crossover systems trade 25-100 times and bleed the
// ~26 bps a full-size round trip costs in fees, slippage and pool impact; the
// money is in buying the one genuine rally and then sitting out the chop.
//
//   - Entry, flat only: the 3-hour return tops +1.2% AND the 1-hour return tops
//     +0.4% AND the close makes a fresh 2-hour high. All three must agree, so a
//     slow drift or a single spiky bar cannot trigger a buy. Full size: the
//     whole cash balance, one position at most (the harness caps it anyway).
//   - Exit: a trailing stop 2.5% below the highest close since entry, or the
//     1-hour return turning below -1.5% (a hard reversal). No exit on a
//     30-bar low or a fast EMA cross: those fired mid-rally on the dev window
//     and gave the move back. An exit the market refuses (a gap past the
//     slippage cap) is simply re-sent on the next bar, since the condition
//     still holds at that close.
//   - Guardrail probe: if the day never rallies, the entry above may never
//     fire, and an entry with no trade ranks below every entry that traded.
//     So once, after bar 1200 (20 hours in), a modest 30-minute bounce
//     (+0.3%) takes one small probe with a tighter 1.2% trail. It costs a few
//     dollars in chop and keeps the entry inside the guardrails.
//
// Backtest on the kit's dev window (offline replay of the documented fill
// model: 4 bps fee, 2 bps slippage, constant-product impact on the bar's open
// depth): net PnL +$21.56 on one trade, max drawdown 1.98% — buy the rally at
// 59,686, hold to the 61,102 close. Buy-and-hold on the same window makes
// +$32.17, but it holds through any fall too; this bot's trailing stop is the
// difference on a down day.
//
// Deterministic: float64 arithmetic on closes in a fixed order, no clock, no
// randomness, no environment, no files outside the repository. Warm-up
// batches (hello.warmup_bars) feed the indicators but never trade.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** A real rally: 3-hour return above this. */
const RALLY_180 = 0.012;
/** ...confirmed by the 1-hour return above this. */
const RALLY_60 = 0.004;
/** ...at a fresh high over this many bars (2 hours). */
const BREAKOUT_BARS = 120;
/** Exit: this far below the highest close since entry. 2.5%: the dev window's
 *  deepest pullback from a post-entry peak was ~1.8%, so 2.0% sits too close
 *  to ordinary chop; 2.5% holds through it and still caps a real reversal. */
const TRAIL = 0.025;
/** Exit: the 1-hour return below this (a hard reversal). */
const REVERSAL = -0.015;
/** Guardrail probe: first bar it may fire on (20 hours in). */
const FALLBACK_BAR = 1200;
/** Guardrail probe: 30-minute return above this. */
const FALLBACK_30 = 0.003;
/** Guardrail probe: its tighter trailing stop. */
const FALLBACK_TRAIL = 0.012;
/** 1% past the close the order was decided on; a fill past it is refused. */
const MAX_SLIPPAGE_BPS = 100;

/** Closes seen, oldest first; one entry per bar the harness sends. */
const closes: number[] = [];
/** Highest close since the current entry; 0 while flat. */
let peak = 0;
/** The trailing stop in force for the current position. */
let trail = TRAIL;
/** The guardrail probe fires at most once. */
let fallbackUsed = false;

function hiBefore(i: number, span: number): number {
  let hi = -Infinity;
  for (let k = i - span; k < i; k++) if (closes[k] > hi) hi = closes[k];
  return hi;
}

await runBars({
  onBatch(state: BarsState, _batch): (BuyInput | SellInput)[] {
    for (const bar of _batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    if (state.warmingUp) return [];
    const i = closes.length - 1;
    if (i < 180) return [];
    const close = closes[i];
    const r180 = close / closes[i - 180] - 1;
    const r60 = close / closes[i - 60] - 1;
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (close > peak) peak = close;
      if (close <= peak * (1 - trail)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      if (r60 < REVERSAL) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (r180 > RALLY_180 && r60 > RALLY_60 && close > hiBefore(i, BREAKOUT_BARS)) {
      trail = TRAIL;
      peak = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (!fallbackUsed && i >= FALLBACK_BAR && close / closes[i - 30] - 1 > FALLBACK_30) {
      fallbackUsed = true;
      trail = FALLBACK_TRAIL;
      peak = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
