# Idle compaction PoC results (2026-11-19)

Part 1a (idle_events.py, real Claude transcripts 2026-11-12..19, weights Fable 7.5, Opus 2.2):
- Fable lead: 77 idle returns (>=60 min, cache gone, >=100k context), paid 711.7M units in the windows that followed, compact-first 409.8M, saving 301.9M. By context: 150-200k 4 events all losing (-1.46M), 200-250k +1.06M, 250-300k +5.0M, 300-400k +19.6M, 400-600k +114.4M, 600k+ +163.4M. Threshold 250k: 71 triggers, +302.4M, 0 losers.
- Opus lead: 24 events, +13.1M net; losers below 350k (7 at 150-200k threshold); 350k: 13 triggers, +14.2M, 0 losers.
- Opus implementer: 6 events, +17.0M (not in default models).
- Parameters measured from 282 real Pi compactions: summary input = 0.27-0.47 x context, billed as cache write (Opus 58.1M write vs 0.36M plain input); output median 8.6-10.4k; post-compaction context S median 171-200k (p90 about 245-268k).

Part 1b + 2 (live, session copies cut at a real idle return, package copy, hello@ account, --tools read, -ne + compaction-anchor):

| case | context at idle | full: units / first answer | compact: units / first answer | summary written / out | score full | score compact |
|---|---|---|---|---|---|---|
| c3 HYM seed | 389k | 2.36M / 13 s | 0.39M / 50 s | 71.4k / 4.6k | 22/22 | 18/22 |
| c1 home Daseo | 397k | 2.95M / 25 s | 0.89M / 66 s | 177.8k / 5.5k | 26/26 | 19/26 |
| c2 HYM office | 326k | 1.84M / 19 s | 0.58M / 77 s | 110.6k / 8.0k | 18/26 | 10/26 |
| c4 HYM root | 457k | 3.25M / 11 s | 0.99M / 71 s | 112.5k / 6.7k | 26/26 | 23/26 |

Live S was 22-67k because the PoC process has almost no tools or instructions; real sessions carry 150k+ of tools and instructions, so live savings overstate real ones. Part 1a uses the real S.

On the 45 items the full arm answered fully: compact kept 31, partial 8, lost 6 (score 70/90 vs 90/90). Open-items question kept 4/4. Every compact miss was "모름" or an incomplete answer; none invented a fact. Losses: c3 Q3, Q4 partial, Q7 lost (caption percentages); c1 Q1 lost (icon cause), Q12 lost (font reason), Q3, Q5, Q11 partial; c2 Q5 lost (assign schedule), Q6 lost (sheet tab/column counts), Q10, Q11 partial; c4 Q2 partial (543 vs final 551), Q3 lost (44 hours).

Message during the summary (steer over RPC): rejected by Pi core, "Cannot submit a prompt while compaction is in progress"; the first message went out after the compaction.
