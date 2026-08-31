# Новое описание команды (вставить на lablab: Team Dashboard → Settings → Team Idea)

THETA DESK: an autonomous options desk on Alpaca. It doesn't predict prices —
it prices the volatility risk premium and runs a two-sleeve book: theta-earning
iron condors hedged by a convexity tail. Every order must survive a 17-gate
risk wall, including a portfolio payoff simulator that reprices the whole book
before each trade. Every decision lands in a hash-chained journal and replays
bit-for-bit. Built by Qwertys with Claude + Featherless on Alpaca's Trading
API, MCP server and CLI.
