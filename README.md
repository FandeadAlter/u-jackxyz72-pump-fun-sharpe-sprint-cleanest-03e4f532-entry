# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/FandeadAlter/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/FandeadAlter/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for a 6-hour pump.fun replay, ranked by hourly Sharpe ratio. Entry for [u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) ($2).

## Strategy — two-phase "lottery + guardrail sprint"

Most coins drift down, and chasing momentum or dips loses. The shape that holds up is the lottery ticket: buy a coin once, early, for a small fixed stake, take profit at +100%, never stop out, and let the rare migrator pay for the tickets.

- **Core mode:** buy once per coin when its real SOL reserves cross 2 SOL, stake 0.02 SOL, no rebuy. Exit at take-profit +100% (sell all), or a stale exit after 36,000 slots held (~4h) when the return is still under +50%. The harness force-closes a position when its curve completes.
- **Sprint mode (guardrail):** once 36,000 slots have elapsed from the first batch's slot and fewer than 20 distinct mints have completed a round trip, buys switch to a 0.01 SOL stake with a 3,000-slot (~20 min) hold cap, then sell. When 20 distinct mints have completed round trips, sprint turns off and core resumes.

This meets the minimum bar (a round trip of at least 0.01 SOL on at least 20 distinct mints, max drawdown 50%) while keeping drawdown small: offline dev-window checks of this design gave Sharpe −0.447, net PnL −0.253 SOL, 75 round trips, max drawdown 3.02% on the full dev window, with 6-hour slices at Sharpe +0.330 / −0.681 / −0.634 — high-variance, dominated by whether a tail winner lands in-window.

## Run

Run with Node 22, standard library only, no dependencies:

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout via the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`). It is fully deterministic: no clock, no environment, no randomness — two runs produce byte-identical action logs.
