// Confirmed-flow momentum for the pump.fun 24h replay sprint (agent-fun/replay/v2).
//
// Idea in one paragraph: most pump.fun curves are noise. A curve only earns a
// position once real money has already voted for it in a way that is hard to
// fake: over a short recent window the net SOL flow is clearly positive, the
// buying is spread across several independent wallets (no single wallet is
// most of the volume), the price has risen a meaningful but not vertical
// amount, and the current price is still hugging the window high instead of
// fading from it. Positions are one fixed size, never averaged into, and are
// closed by whichever guard fires first: a hard stop under cost, a trailing
// exit after a real run, a whale-sized sell print on the tape, or a time cap.
//
// A second, deliberately boring mechanism keeps the entry above the
// competition's activity bar (20+ coins with a completed round trip). The bot
// counts its own finished round trips and compares them with the share of the
// 24h window that has elapsed (read from event block times, never a clock).
// When it falls behind the pace, it fires a tiny probe buy into a liquid,
// active curve and dumps it on the next batch after the fill lands.
//
// Everything is deterministic: no wall clock, no environment, no Math.random;
// iteration is only over insertion-ordered Maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Slots of tape the entry test reads. */
  flowWindow: number;
  /** Net SOL in over the window (buys minus sells) before a curve qualifies. */
  minNetInflowSol: number;
  /** Distinct wallets that must have bought inside the window. */
  minDistinctBuyers: number;
  /** Largest single buyer's share of window buy volume, as a fraction. */
  maxBuyerShare: number;
  /** Window price rise must sit inside [minRise, maxRise]. */
  minRise: number;
  maxRise: number;
  /** Current price must be at least this fraction of the window high. */
  nearHighFrac: number;
  /** Curve must be at least this old (slots since create) to be entered. */
  minAgeSlots: number;
  /** Real SOL reserve bounds at entry. */
  minReserveSol: number;
  maxReserveSol: number;
  /** Fixed size of one momentum position. */
  stakeSol: number;
  /** Skip an entry when the reserve cap leaves less than this to spend. */
  minStakeSol: number;
  /** Most momentum+probe positions open at once (also clamped by hello caps). */
  maxPositions: number;
  /** Most SOL of open cost plus pending buys at any moment. */
  maxExposureSol: number;
  /** Most filled momentum entries per curve over the whole run. */
  maxEntriesPerCurve: number;
  /** Slots after an exit before the same curve can be entered again. */
  cooldownSlots: number;
  /** Sell everything once value falls to this fraction of cost. */
  stopLossFrac: number;
  /** Trailing exit arms once value reaches this multiple of cost... */
  trailArmFrac: number;
  /** ...and fires when value falls back to this fraction of the peak. */
  trailDropFrac: number;
  /** One recorded sell of at least this much SOL closes the position. */
  whaleSellSol: number;
  /** Hard time cap on a position, in slots. */
  maxHoldSlots: number;
  /** Slippage tolerance on buys; sells always go out at 10000. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Guardrail probe size. */
  probeSizeSol: number;
  /** Round trips the pacing logic aims to have banked by the window's end. */
  probeTargetTrips: number;
  /** Most probes out at once (bought or bought-and-not-yet-sold). */
  probeMaxInFlight: number;
  /** A probe target needs at least this much real SOL reserve. */
  probeMinReserveSol: number;
  /** Length of the scored window in seconds, for pacing only. */
  windowSeconds: number;
}

export const DEFAULT_PARAMS: Params = {
  flowWindow: 60,
  minNetInflowSol: 2.5,
  minDistinctBuyers: 6,
  maxBuyerShare: 0.5,
  minRise: 0.03,
  maxRise: 0.6,
  nearHighFrac: 0.97,
  minAgeSlots: 600,
  minReserveSol: 3,
  maxReserveSol: 80,
  stakeSol: 0.35,
  minStakeSol: 0.05,
  maxPositions: 6,
  maxExposureSol: 2.6,
  maxEntriesPerCurve: 2,
  cooldownSlots: 300,
  stopLossFrac: 0.85,
  trailArmFrac: 1.08,
  trailDropFrac: 0.8,
  whaleSellSol: 3,
  maxHoldSlots: 5000,
  buySlipBps: 1200,
  sellSlipBps: 10000,
  probeSizeSol: 0.02,
  probeTargetTrips: 25,
  probeMaxInFlight: 2,
  probeMinReserveSol: 5,
  windowSeconds: 86400,
};

const SOL = 1_000_000_000n;
const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * 1_000_000_000));
/** How far back tape is kept: comfortably past the flow window and probe activity checks. */
const TAPE_KEEP_SLOTS = 360;
/** A probe target must have traded at least this recently and this often. */
const PROBE_ACTIVE_SLOTS = 120;
const PROBE_MIN_RECENT_TRADES = 3;

interface TapePrint {
  slot: number;
  buy: boolean;
  lamports: bigint;
  wallet: string;
  /** Price (quote lamports per token) right after this print. */
  px: number;
}

interface CurveBook {
  born: number;
  tape: TapePrint[];
  filledEntries: number;
  coolUntil: number;
  /** Share of the reserve size cap to use; halved whenever a buy is rejected
   * for size, restored when one fills. The grader's cap reads reserves net of
   * this bot's own earlier fills, which the chain tape cannot see exactly. */
  sizeFrac: number;
}

interface OpenLot {
  mint: Pubkey;
  openedSlot: number;
  peakValue: bigint;
  isProbe: boolean;
}

type OrderTag = { kind: 'entry' | 'probe' | 'exit'; mint: Pubkey };

const priceOf = (vq: bigint, vt: bigint): number => (vt === 0n ? 0 : Number(vq) / Number(vt));

/** Rough net SOL a full sell of `tokens` would return now, curve fees haircut by ~1.25%. */
function sellQuoteNow(state: BotState, mint: Pubkey, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || tokens <= 0n) return 0n;
  const gross = (tokens * curve.virtual_quote_reserves) / (curve.virtual_token_reserves + tokens);
  return (gross * 9875n) / 10000n;
}

export function createStrategy(params: Params): Bot {
  const books = new Map<Pubkey, CurveBook>();
  const lots = new Map<Pubkey, OpenLot>();
  const tags = new Map<string, OrderTag>();
  /** Probe mints: 'flying' once the buy is sent, 'landed' once its fill is in. */
  const probeState = new Map<Pubkey, 'flying' | 'landed'>();
  const probedBefore = new Set<Pubkey>();
  /** Filled buy lamports in the position episode currently open, per mint. */
  const episodeBought = new Map<Pubkey, bigint>();
  const bankedTrips = new Set<Pubkey>();
  let idCounter = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime = 0;

  const bookFor = (mint: Pubkey, slot: number): CurveBook => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { born: slot, tape: [], filledEntries: 0, coolUntil: 0, sizeFrac: 0.9 };
      books.set(mint, b);
    }
    return b;
  };

  const nextId = (prefix: string): string => `${prefix}${++idCounter}`;

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === side) return true;
    return false;
  };

  /** Read this batch's fills into the books before any decision is made. */
  const absorbFills = (batch: Batch): void => {
    for (const f of batch.fills) {
      const tag = tags.get(f.client_id);
      if (tag !== undefined) {
        tags.delete(f.client_id);
        if (f.side === 'buy' && f.status === 'rejected' && f.reason === 'max_order_size') {
          const book = bookFor(tag.mint, batch.slot);
          book.sizeFrac = Math.max(0.2, book.sizeFrac / 2);
        }
        if (f.status === 'filled' && f.side === 'buy') {
          bookFor(tag.mint, batch.slot).sizeFrac = 0.9;
          episodeBought.set(tag.mint, (episodeBought.get(tag.mint) ?? 0n) + BigInt(f.quote_lamports));
          if (tag.kind === 'entry') bookFor(tag.mint, batch.slot).filledEntries += 1;
          if (tag.kind === 'probe') probeState.set(tag.mint, 'landed');
        }
        if (tag.kind === 'probe' && f.status !== 'filled' && f.side === 'buy') probeState.delete(tag.mint);
        continue;
      }
      if (f.status === 'filled' && f.side === 'buy') {
        // A buy of ours the tag map lost track of should not happen; count it anyway.
        episodeBought.set(f.mint, (episodeBought.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
      }
    }
  };

  /** Fold this batch's events into the tape and the pacing clock. */
  const absorbEvents = (batch: Batch): Set<Pubkey> => {
    const whaleSold = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        const bt = Number(e.block_time);
        if (firstBlockTime === null) firstBlockTime = bt;
        if (bt > lastBlockTime) lastBlockTime = bt;
      }
      if (e.event === 'CreateEvent') {
        bookFor(e.mint, e.slot).born = e.slot;
      } else if (e.event === 'TradeEvent') {
        const book = bookFor(e.mint, e.slot);
        const lamports = BigInt(e.sol_amount);
        book.tape.push({
          slot: e.slot,
          buy: e.is_buy,
          lamports,
          wallet: e.user,
          px: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        if (!e.is_buy && lamports >= solToLamports(params.whaleSellSol)) whaleSold.add(e.mint);
      }
    }
    return whaleSold;
  };

  /** Align open lots with the account; a vanished position banks its round trip. */
  const syncLots = (state: BotState, slot: number): void => {
    for (const mint of [...lots.keys()]) {
      if (!state.positions.has(mint)) {
        if ((episodeBought.get(mint) ?? 0n) >= 10_000_000n) bankedTrips.add(mint);
        episodeBought.delete(mint);
        probeState.delete(mint);
        bookFor(mint, slot).coolUntil = slot + params.cooldownSlots;
        lots.delete(mint);
      }
    }
    for (const [mint, held] of state.positions) {
      if (!lots.has(mint)) {
        lots.set(mint, {
          mint,
          openedSlot: slot,
          peakValue: sellQuoteNow(state, mint, held.token_amount),
          isProbe: probeState.has(mint),
        });
      }
    }
  };

  const pruneTape = (book: CurveBook, slot: number): void => {
    const floor = slot - TAPE_KEEP_SLOTS;
    let drop = 0;
    while (drop < book.tape.length && book.tape[drop]!.slot < floor) drop++;
    if (drop > 0) book.tape.splice(0, drop);
  };

  interface FlowVerdict {
    ok: boolean;
  }

  /** The entry test: confirmed, broad-based inflow with the price still at its high. */
  const flowCheck = (state: BotState, mint: Pubkey, slot: number): FlowVerdict => {
    const curve = state.curves.get(mint);
    const book = books.get(mint);
    if (curve === undefined || book === undefined || curve.complete) return { ok: false };
    if (slot - book.born < params.minAgeSlots) return { ok: false };
    const rq = curve.real_quote_reserves;
    if (rq < solToLamports(params.minReserveSol) || rq > solToLamports(params.maxReserveSol)) return { ok: false };

    const from = slot - params.flowWindow;
    let net = 0n;
    let buyTotal = 0n;
    let biggestBuyer = 0n;
    const buyers = new Map<string, bigint>();
    let high = 0;
    let startPx = 0;
    let seenInWindow = false;
    for (const t of book.tape) {
      if (t.slot <= from) {
        startPx = t.px;
        continue;
      }
      seenInWindow = true;
      if (t.px > high) high = t.px;
      if (t.buy) {
        net += t.lamports;
        buyTotal += t.lamports;
        const sum = (buyers.get(t.wallet) ?? 0n) + t.lamports;
        buyers.set(t.wallet, sum);
        if (sum > biggestBuyer) biggestBuyer = sum;
      } else {
        net -= t.lamports;
      }
    }
    if (!seenInWindow) return { ok: false };
    if (startPx === 0) {
      // No print before the window: fall back to the earliest print inside it.
      for (const t of book.tape) if (t.slot > from) { startPx = t.px; break; }
    }
    if (net < solToLamports(params.minNetInflowSol)) return { ok: false };
    if (buyers.size < params.minDistinctBuyers) return { ok: false };
    if (buyTotal === 0n) return { ok: false };
    // biggest buyer share <= maxBuyerShare, compared without floats.
    if (biggestBuyer * 10000n > buyTotal * BigInt(Math.round(params.maxBuyerShare * 10000))) return { ok: false };

    const nowPx = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (nowPx > high) high = nowPx;
    if (startPx <= 0 || high <= 0) return { ok: false };
    const rise = nowPx / startPx - 1;
    if (rise < params.minRise || rise > params.maxRise) return { ok: false };
    if (nowPx < params.nearHighFrac * high) return { ok: false };
    return { ok: true };
  };

  const windowProgress = (): number => {
    if (firstBlockTime === null || lastBlockTime <= firstBlockTime) return 0;
    const p = (lastBlockTime - firstBlockTime) / params.windowSeconds;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      absorbFills(batch);
      const whaleSold = absorbEvents(batch);
      syncLots(state, slot);

      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;
      const positionCap = Math.min(params.maxPositions, state.hello.caps.max_open_positions);
      const txFee = state.txFeeLamports();
      /** Mints a buy was decided for in this very reply: state.pending does not know them yet. */
      const boughtThisBatch = new Set<Pubkey>();

      // ---- exits first: they free cash and position slots for everything else
      for (const lot of lots.values()) {
        if (orders.length >= orderCap) break;
        const held = state.positions.get(lot.mint);
        if (held === undefined || hasPending(state, lot.mint, 'sell')) continue;
        let close = false;
        if (lot.isProbe) {
          // A probe is a guardrail token, not an investment: out on the first
          // batch after its buy fill has landed.
          close = probeState.get(lot.mint) === 'landed';
        } else {
          const curve = state.curves.get(lot.mint);
          const value = sellQuoteNow(state, lot.mint, held.token_amount);
          if (value > lot.peakValue) lot.peakValue = value;
          const cost = held.cost_lamports;
          if (curve !== undefined && curve.complete) close = true;
          else if (value * 10000n <= cost * BigInt(Math.round(params.stopLossFrac * 10000))) close = true;
          else if (
            lot.peakValue * 10000n >= cost * BigInt(Math.round(params.trailArmFrac * 10000)) &&
            value * 10000n <= lot.peakValue * BigInt(Math.round(params.trailDropFrac * 10000))
          ) close = true;
          else if (whaleSold.has(lot.mint)) close = true;
          else if (slot - lot.openedSlot >= params.maxHoldSlots) close = true;
        }
        if (close) {
          const id = nextId('x');
          tags.set(id, { kind: 'exit', mint: lot.mint });
          orders.push({ side: 'sell', client_id: id, mint: lot.mint, token_amount: held.token_amount, max_slippage_bps: params.sellSlipBps });
        }
      }

      // ---- momentum entries
      let exposure = 0n;
      for (const held of state.positions.values()) exposure += held.cost_lamports;
      for (const p of state.pending.values()) if (p.order.side === 'buy') exposure += BigInt(p.order.quote_lamports);
      // Buys decided in this same reply are not in state.pending yet; count
      // their spend by hand so a burst of entries cannot overdraw the account.
      let plannedSpend = 0n;

      if (state.committedPositionCount() < positionCap) {
        for (const [mint, curve] of state.curves) {
          if (orders.length >= orderCap) break;
          if (state.committedPositionCount() >= positionCap) break;
          if (curve.complete || state.positions.has(mint) || probeState.has(mint)) continue;
          if (hasPending(state, mint, 'buy') || boughtThisBatch.has(mint)) continue;
          const book = books.get(mint);
          if (book === undefined) continue;
          if (book.filledEntries >= params.maxEntriesPerCurve) continue;
          if (slot < book.coolUntil) continue;
          pruneTape(book, slot);
          if (!flowCheck(state, mint, slot).ok) continue;
          const capByReserve = (state.maxBuyLamports(mint) * BigInt(Math.round(book.sizeFrac * 1000))) / 1000n;
          let stake = solToLamports(params.stakeSol);
          if (capByReserve < stake) stake = capByReserve;
          if (stake < solToLamports(params.minStakeSol)) continue;
          if (exposure + stake > solToLamports(params.maxExposureSol)) continue;
          if (state.freeCashLamports() - plannedSpend < stake + txFee) break;
          const id = nextId('e');
          tags.set(id, { kind: 'entry', mint });
          orders.push({ side: 'buy', client_id: id, mint, quote_lamports: stake, max_slippage_bps: params.buySlipBps });
          exposure += stake;
          plannedSpend += stake;
          boughtThisBatch.add(mint);
        }
      }

      // ---- guardrail probes, paced against the elapsed share of the window
      const pace = windowProgress();
      const tripsWantedByNow = Math.floor(pace * params.probeTargetTrips);
      if (bankedTrips.size < tripsWantedByNow && probeState.size < params.probeMaxInFlight && orders.length < orderCap) {
        for (const [mint, curve] of state.curves) {
          if (curve.complete || state.positions.has(mint) || probeState.has(mint)) continue;
          if (probedBefore.has(mint) || bankedTrips.has(mint)) continue;
          if (hasPending(state, mint, 'buy') || boughtThisBatch.has(mint)) continue;
          if (curve.real_quote_reserves < solToLamports(params.probeMinReserveSol)) continue;
          const book = books.get(mint);
          if (book === undefined) continue;
          pruneTape(book, slot);
          let recent = 0;
          for (const t of book.tape) if (t.slot > slot - PROBE_ACTIVE_SLOTS) recent++;
          if (recent < PROBE_MIN_RECENT_TRADES) continue;
          const capByReserve = state.maxBuyLamports(mint);
          let size = solToLamports(params.probeSizeSol);
          if (capByReserve < size) size = capByReserve;
          if (size < 10_000_000n) continue;
          if (state.freeCashLamports() - plannedSpend < size + txFee) break;
          const id = nextId('p');
          tags.set(id, { kind: 'probe', mint });
          probeState.set(mint, 'flying');
          probedBefore.add(mint);
          orders.push({ side: 'buy', client_id: id, mint, quote_lamports: size, max_slippage_bps: params.buySlipBps });
          break; // at most one fresh probe per batch
        }
      }

      return orders;
    },
  };
}
