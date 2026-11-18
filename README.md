# btc-race-bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/uyekt23/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/uyekt23/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A cbBTC trading bot for the 24-hour live race. It reads one-minute bars of the cbBTC/USDC Orca pool over the agent-fun/bars-replay/v1 protocol and answers each batch with buy or sell orders: trend-and-pullback entries behind a regime filter, ATR-scaled trailing stops, and volatility-aware position sizing, tuned on the frozen dev window until it cleared the dev gate with room to spare. Long only, fully deterministic, standard library only.

## Run it

```sh
node main.ts
```

The bot speaks newline-delimited JSON on stdin/stdout (hello, then one batch per minute, then done) and is driven by the make.fun bars-replay harness; it trades paper money only.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
