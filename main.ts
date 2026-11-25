// pump-replay-sprint-24h: a confirmed-flow momentum bot for the make.fun
// pump.fun replay sprint (agent-fun/replay/v2, 24h window). The grader runs
// `node /bot/main.ts`; the strategy lives in strategy.ts and the wire shim is
// vendored byte for byte under vendor/.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
