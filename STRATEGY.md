# Strategy notes — confirmed-flow momentum (24h replay)

## Entry: only follow flow that is already confirmed

A curve qualifies when all of these hold over the last 60 slots of its tape:

- curve age at least 600 slots (fresh launches are mostly bundled and dumped);
- real SOL reserve between 3 and 80 SOL;
- net inflow (buys − sells) at least 2.5 SOL;
- at least 6 distinct buying wallets, and the largest single buyer accounts
  for no more than 50% of buy volume (wash flow tends to be one wallet);
- price up between +3% and +60% versus the window start — moving, not vertical;
- current price at or above 97% of the window high — riding strength, not a bounce.

## Sizing

One fixed 0.35 SOL position per entry (clipped by the harness's
1%-of-real-reserve order cap), never averaged into. At most 6 positions
(the harness caps open positions at 5), total open cost plus pending buys
capped at 2.6 SOL, at most 2 entries per curve per run, 300-slot cooldown
after an exit.

One sizing subtlety found in local backtests: the size cap is enforced
against reserves net of this bot's own earlier fills on the curve, which the
chain tape cannot see exactly, so full-cap re-entry orders on a curve the bot
has traded before get rejected for size. The bot therefore starts at 90% of
the nominal cap on every curve, halves its size fraction whenever a buy is
rejected for size, and restores it when a buy fills.

## Exits: first trigger wins

- value at or below 85% of cost — hard stop;
- after value has reached 108% of cost, a fall back to 80% of the peak —
  trailing exit;
- any single recorded sell of 3 SOL or more on the curve — whale leaving;
- 5000 slots held — time cap.

Sells go out at 10000 bps slippage tolerance; buys at 1200 bps.

## Guardrail probes

The competition only ranks entries that complete round trips of at least
0.01 SOL on at least 20 coins, with max drawdown at most 50%. The bot counts
its own banked round trips and compares them with the elapsed share of the
24h window (from event block times, never a clock). Behind pace, it buys a
0.02 SOL probe into a liquid (≥5 SOL real reserve), recently active curve it
has not touched before, and sells the whole lot on the first batch after the
buy fill lands. At most 2 probes are out at once.

## Determinism

No clock, no environment reads, no Math.random. All iteration is over
insertion-ordered Maps fed by the batch stream, so two executions of the same
entry produce byte-identical action logs.
