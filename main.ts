// Capitulation-reversal bot for the cbBTC bars-replay race.
//
// Idea in five lines:
//   1. After a sharp slide (close down more than DECLINE_BPS over the last
//      LOOKBACK bars) the tape usually bases and snaps back; buy-and-hold
//      through the slide itself is what loses money, so we never chase it.
//   2. We wait for proof the slide is over: the close crosses back above its
//      EMA(EMA_SPAN) from below and is already higher than 10 bars ago.
//   3. Then we buy once, sized at SIZE_BPS of cash, and let the rebound run.
//   4. We sell the whole position when the close falls TRAIL_BPS below the
//      highest close since entry (trailing stop), falls STOP_BPS below the
//      position's cost (hard stop), or momentum fades (RSI over RSI_EXIT with
//      the close back under the EMA).
//   5. After an exit we rest COOLDOWN bars so a whipsaw cannot re-enter us.
//
// Two fallbacks exist only so a tape that never slides still trades: if no
// buy has filled by BREAKOUT_ARM bars and the close breaks a BREAKOUT_SPAN
// high inside a confirmed uptrend, we ride the breakout smaller; if still
// nothing has filled by PROBE_ARM bars and the tape is not in freefall, a
// small probe position keeps the entry inside the race guardrails. On the
// dev window the reversal fires first, so neither fallback ever arms there.
//
// The wire is the kit SDK's job: hello arrives once, then one batch per bar,
// and each batch is answered with one reply carrying our orders. Everything
// here is streaming and deterministic: float64 EMAs and a Wilder RSI fed only
// by bar closes, no clock, no randomness, no environment.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const EMA_SPAN = 20;
const EMA_MID_SPAN = 120;
const EMA_SLOW_SPAN = 240;
const LOOKBACK = 180;
const DECLINE_BPS = 120; // 1.20% slide over LOOKBACK bars arms the entry
const MOMENTUM_LAG = 10;
const SIZE_BPS = 9000; // 90% of cash for the reversal entry
const TRAIL_BPS = 100; // tuned to the middle of the profitable plateau
const STOP_BPS = 120;
const RSI_SPAN = 14;
const RSI_EXIT = 72;
const COOLDOWN = 45;
const MAX_SLIPPAGE_BPS = 250;
// Fallback breakout (mode 2) and late probe (mode 3).
const BREAKOUT_ARM = 600;
const BREAKOUT_SPAN = 240;
const BREAKOUT_SIZE_BPS = 6000;
const BREAKOUT_TRAIL_BPS = 120;
const BREAKOUT_STOP_BPS = 150;
const PROBE_ARM = 1150;
const PROBE_SIZE_BPS = 2500;
const PROBE_TRAIL_BPS = 80;
const PROBE_STOP_BPS = 80;
const PROBE_MAX_SLIDE_BPS = 150; // probe only if the last 60 bars fell less

/** Streaming EMA seeded by the mean of its first span of closes. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function makeEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

/** Streaming Wilder RSI over closes. */
interface Rsi {
  span: number;
  prev: number | null;
  seen: number;
  avgGain: number;
  avgLoss: number;
  value: number | null;
}

function makeRsi(span: number): Rsi {
  return { span, prev: null, seen: 0, avgGain: 0, avgLoss: 0, value: null };
}

function stepRsi(r: Rsi, close: number): void {
  if (r.prev === null) {
    r.prev = close;
    return;
  }
  const delta = close - r.prev;
  r.prev = close;
  const gain = delta > 0 ? delta : 0;
  const loss = delta < 0 ? -delta : 0;
  r.seen += 1;
  if (r.seen < r.span) {
    r.avgGain += gain / r.span;
    r.avgLoss += loss / r.span;
    return;
  }
  if (r.seen === r.span) {
    r.avgGain += gain / r.span;
    r.avgLoss += loss / r.span;
  } else {
    r.avgGain = (r.avgGain * (r.span - 1) + gain) / r.span;
    r.avgLoss = (r.avgLoss * (r.span - 1) + loss) / r.span;
  }
  if (r.avgLoss === 0) {
    r.value = gain > 0 || r.avgGain > 0 ? 100 : 50;
  } else {
    r.value = 100 - 100 / (1 + r.avgGain / r.avgLoss);
  }
}

let symbol: string | null = null;
const emaFast = makeEma(EMA_SPAN);
const emaMid = makeEma(EMA_MID_SPAN);
const emaSlow = makeEma(EMA_SLOW_SPAN);
const rsi = makeRsi(RSI_SPAN);
const closes: number[] = [];
let prevClose: number | null = null;
let prevEma: number | null = null;
let peakClose: number | null = null;
let barsSinceExit = COOLDOWN;
let wasHolding = false;
let hasTraded = false;
let pendingMode = 0; // entry mode of the buy we most recently sent
let activeMode = 0; // entry mode of the position currently held

function trailFor(mode: number): number {
  if (mode === 2) return BREAKOUT_TRAIL_BPS;
  if (mode === 3) return PROBE_TRAIL_BPS;
  return TRAIL_BPS;
}

function stopFor(mode: number): number {
  if (mode === 2) return BREAKOUT_STOP_BPS;
  if (mode === 3) return PROBE_STOP_BPS;
  return STOP_BPS;
}

await runBars({
  onHello(state: BarsState) {
    symbol = state.hello.symbols[0]?.symbol ?? null;
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    if (symbol === null) return [];
    for (const fill of batch.fills) {
      if (fill.symbol === symbol && fill.side === 'buy' && fill.status === 'filled') {
        hasTraded = true;
      }
    }
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];

    const close = Number(bar.c);
    const emaBefore = emaFast.value;
    stepEma(emaFast, close);
    stepEma(emaMid, close);
    stepEma(emaSlow, close);
    stepRsi(rsi, close);
    closes.push(close);
    const idx = closes.length - 1;

    const held = state.positions.get(symbol);
    const orders: OrderInput[] = [];

    if (state.warmingUp) {
      prevClose = close;
      prevEma = emaBefore;
      return [];
    }

    if (held !== undefined) {
      // Track the rebound's high-water mark and apply the exits. The peak and
      // the mode are adopted when the position first appears, so a sell the
      // market rejects is simply sent again on a later bar.
      if (!wasHolding) {
        peakClose = close;
        activeMode = pendingMode;
      } else {
        peakClose = peakClose === null ? close : Math.max(peakClose, close);
      }
      wasHolding = true;
      const value = state.value(symbol, held.qty);
      const trailHit =
        peakClose !== null &&
        close * 10_000 <= peakClose * (10_000 - trailFor(activeMode));
      const stopHit = value * 10_000n <= held.cost * BigInt(10_000 - stopFor(activeMode));
      const fadeHit =
        rsi.value !== null &&
        rsi.value > RSI_EXIT &&
        emaFast.value !== null &&
        close < emaFast.value;
      if (trailHit || stopHit || fadeHit) {
        orders.push({
          side: 'sell',
          symbol,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    } else {
      if (wasHolding) {
        barsSinceExit = 0;
        peakClose = null;
        activeMode = 0;
      } else {
        barsSinceExit += 1;
      }
      wasHolding = false;

      let sizeBps = 0;
      let mode = 0;
      // Entry: a real slide behind us, the close crossing back over the EMA,
      // short momentum already positive, and the cooldown served.
      const crossedUp =
        prevClose !== null &&
        prevEma !== null &&
        emaFast.value !== null &&
        prevClose <= prevEma &&
        close > emaFast.value;
      const declineOk =
        idx >= LOOKBACK &&
        closes[idx - LOOKBACK] !== undefined &&
        close * 10_000 <= closes[idx - LOOKBACK]! * (10_000 - DECLINE_BPS);
      const momentumOk =
        idx >= MOMENTUM_LAG && close > closes[idx - MOMENTUM_LAG]!;
      if (crossedUp && declineOk && momentumOk && barsSinceExit >= COOLDOWN) {
        sizeBps = SIZE_BPS;
        mode = 1;
      } else if (
        !hasTraded &&
        idx >= BREAKOUT_ARM &&
        emaFast.value !== null &&
        emaMid.value !== null &&
        emaSlow.value !== null &&
        emaFast.value > emaMid.value &&
        close > emaSlow.value &&
        idx >= BREAKOUT_SPAN &&
        closes.slice(idx - BREAKOUT_SPAN, idx).every((c) => close > c)
      ) {
        // Fallback breakout: a fresh BREAKOUT_SPAN high inside an uptrend.
        sizeBps = BREAKOUT_SIZE_BPS;
        mode = 2;
      } else if (
        !hasTraded &&
        idx >= PROBE_ARM &&
        emaSlow.value !== null &&
        close * 10_000 >= emaSlow.value * (10_000 - 50) &&
        idx >= 60 &&
        close * 10_000 >= closes[idx - 60]! * (10_000 - PROBE_MAX_SLIDE_BPS)
      ) {
        // Late probe: the tape never slid and never broke out, but it is not
        // in freefall either, so a small position keeps us in the race.
        sizeBps = PROBE_SIZE_BPS;
        mode = 3;
      }
      if (sizeBps > 0) {
        let notional = (state.cash * BigInt(sizeBps)) / 10_000n;
        const room = state.weightRoom(symbol);
        if (notional > room) notional = room;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({
            side: 'buy',
            symbol,
            notional_quote_units: notional,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          pendingMode = mode;
        }
      }
    }

    prevClose = close;
    prevEma = emaBefore;
    return orders;
  },
});
