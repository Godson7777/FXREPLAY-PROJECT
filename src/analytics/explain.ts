/**
 * "How to read" guides for every analytics tool. Each entry answers four
 * questions: what it measures, how to read it, what good looks like and what
 * to watch out for. Thresholds match the Overflow Score anchors in score.ts.
 */
export interface Explain {
  what: string;
  read: string;
  good: string;
  watch?: string;
}

export const EXPLAIN = {
  score: {
    what: 'One number from 0 to 100 that sums up whether the backtest shows a real, durable edge. It blends seven pillars — profitability, risk-adjusted return, drawdown, consistency, market regimes, statistical confidence and execution — and then applies hard caps for known failure modes.',
    read: 'Start with the grade and the verdict, then open the pillars to see which part pulls the score up or down. "Worth trading long-term?" is the bottom line. The suggestions list the most useful fixes first.',
    good: '80+ with the all-weather label is the goal: profitable in trending and ranging markets, shallow drawdowns, no month losing more than an average month earns, and statistically significant. 70–79 is a robust edge; 60–69 promising; below 50 not proven.',
    watch: 'A score is only as good as the sample. Under 50 trades or 3 months it is capped, because a short test cannot show how the method behaves in different conditions. Synthetic practice data is scored but never ranked.',
  },
  pillars: {
    what: 'The seven building blocks of the score. Each pillar turns a few metrics into points (0–100) using fixed anchor tables, then the pillars are averaged by weight.',
    read: 'Click a pillar to see its metrics, the measured value and the points each one earned. A metric shows "—" when there is not enough data yet; it is then left out instead of counting as zero.',
    good: 'Every pillar above 70 means there is no obvious weak spot. One pillar far below the others is usually the first thing to fix.',
  },
  gates: {
    what: 'Hard limits that cap the score no matter how good the rest looks: too few trades, a negative expectancy, a drawdown beyond 30%, an edge that disappears without the top 5% of trades, losses in most market regimes, a worst month that lost more than an average month earns, or a test shorter than 3 months.',
    read: 'A red flag that "caps" the score lowered it to the cap shown. A flag that does not cap is still a warning: the score was already below that cap.',
    good: 'No flags at all.',
  },
  kpis: {
    what: 'The headline numbers of the track record: net result, return (and annualized return once the test spans 60+ days), win rate, profit factor, expectancy per trade and maximum drawdown.',
    read: 'Read them together — a high win rate means little if the average loss is much bigger than the average win. Expectancy (what one more trade is worth, in risk units) and profit factor are the two that matter most.',
    good: 'Expectancy above +0.20 R and a profit factor above 1.5 with a drawdown under 20%.',
    watch: 'Combined reports (strategies, all sessions) place every trade on one reference account using its % return, so dollar figures can differ from the individual sessions.',
  },
  challenge: {
    what: 'How this session did against its prop-firm evaluation rules: profit target, daily loss limit, maximum loss and minimum trading days, checked on every 1-minute bar.',
    read: 'Compare each value with its limit. A breach ends the challenge as failed; hitting the target after the minimum trading days passes it.',
    good: 'Target reached with plenty of room to both loss limits.',
  },
  equity: {
    what: 'Account balance after each closed trade (and, for a single session without filters, the equity including open positions).',
    read: 'Look at the shape, not only the end point: a steady staircase is better than one big jump. Flat or falling stretches show when the method stopped working.',
    good: 'A smooth line rising from bottom-left to top-right (equity R² near 1).',
    watch: 'A curve can look great because of one or two outsized trades — check the outlier test under Robustness.',
  },
  drawdown: {
    what: 'How far the account is below its previous high at every point (the "underwater" curve).',
    read: 'Depth shows how much pain the method causes; width shows how long it takes to recover. Long, deep valleys are what make traders abandon a method.',
    good: 'Shallow (under 10–15%) and short drawdowns that recover quickly.',
    watch: 'The next drawdown can be deeper than the worst one in the test — see the Monte Carlo drawdown distribution.',
  },
  keystats: {
    what: 'Detailed trade statistics: average win and loss, payoff, streaks, holding times, long vs short, excursions (MAE/MFE), SQN, Kelly and more.',
    read: 'Use these to understand how the edge is made: many small wins, or few big ones? Do losers last longer than winners? Is one side (long or short) carrying the result?',
    good: 'Payoff × win rate comfortably above (1 − win rate); SQN above 2; losers cut faster than winners.',
    watch: 'Kelly % is a theoretical maximum. Risking more than a quarter to half of it usually leads to drawdowns that are hard to sit through.',
  },
  riskAdjusted: {
    what: 'Return per unit of risk. Sharpe divides the average daily return by its volatility; Sortino counts only downside volatility; Calmar divides annual return by the maximum drawdown; Martin divides it by the Ulcer index; Gain-to-Pain is the sum of monthly returns over the sum of monthly losses; R² measures how straight the equity curve is.',
    read: 'All ratios are "higher is better". Sharpe and Sortino are annualized from daily returns (252 days for 5-day markets, 365 when trades also close at weekends).',
    good: 'Sharpe above 1 is good and above 2 excellent; Sortino above 1.5; Calmar above 1 (the strategy earns its worst drawdown back within a year); R² above 0.9.',
    watch: 'Ratios from a few weeks of data are unstable. Calmar and Martin need at least 60 days; Sharpe and Sortino need 20 trading days.',
  },
  tailRisk: {
    what: 'How bad the bad outcomes are. VaR 95% is the loss that 95% of trades (or days) stay above; CVaR 95% is the average of the worst 5%. Ulcer index combines depth and duration of drawdowns.',
    read: 'Compare CVaR per trade with your intended risk per trade. If CVaR is much larger, some losses ran past their stops or were oversized.',
    good: 'CVaR per trade close to your normal risk (for example −1% when risking 1%) and an Ulcer index under 5.',
    watch: 'Tail measures need at least 20 trades (VaR per day needs 40 trading days) and are still noisy with small samples.',
  },
  streaks: {
    what: 'The longest losing streak in the test compared with the streak you should expect from pure chance given your win rate and number of trades.',
    read: 'If the actual streak is far longer than expected, losses tend to cluster — often a sign that the method fails in certain market phases.',
    good: 'Actual streak around or below the expected value.',
    watch: 'Even a good method will show a streak this long again. Size so that twice this streak is survivable.',
  },
  monthlyRule: {
    what: 'The core consistency rule: the worst month should not lose more than an average month earns.',
    read: 'The bars compare the loss of the worst month with the average monthly return. A ratio of 1× means one bad month wipes out one average month.',
    good: 'Ratio at or below 1×, or no losing month at all.',
    watch: 'Needs at least 3 months. With fewer months the rule cannot be judged yet.',
  },
  monthlyTable: {
    what: 'Return of every calendar month (in the chart timezone), measured on the account balance at the start of that month.',
    read: 'Scan for patterns: are losses spread out or concentrated in a season? Does the edge fade in later months?',
    good: 'Mostly positive months (60%+) with small negatives.',
  },
  rolling: {
    what: 'Expectancy measured over a moving window of recent trades, plotted trade by trade.',
    read: 'The line shows whether the edge is stable, improving or decaying. Dips below zero are periods where the method lost money.',
    good: 'The line stays above zero most of the time without a downward trend.',
    watch: 'A falling line at the end of the test can mean the market changed — keep testing more recent data before trading it.',
  },
  halves: {
    what: 'The trades split in two by time: first half vs second half, with expectancy, win rate and profit factor for each.',
    read: 'A real edge shows up in both halves. If only one half is profitable, the result depended on one market phase.',
    good: 'Both halves positive and of similar size.',
  },
  calendar: {
    what: 'Profit or loss of every trading day, colored by size.',
    read: 'Look for clusters of red days (bad weeks) and for days with outsized results.',
    good: 'Many small green days, few red days, no single day dominating the month.',
  },
  regimeTrend: {
    what: 'Results split by the market trend at entry, measured on the 4-hour chart: uptrend, downtrend or ranging. A market counts as trending when ADX(14) is 20 or more; the direction comes from +DI/−DI. Only data before the entry is used, so there is no lookahead.',
    read: 'Each bar is the expectancy in that regime. A robust method makes money in every regime, or at least does not lose in any.',
    good: 'All three positive. The all-weather label needs profits both in ranging markets and in at least one trend direction.',
    watch: 'Regimes with fewer than 5 trades are shown but not judged.',
  },
  regimeVol: {
    what: 'Results split by volatility at entry: the 4-hour ATR(14) as % of price, ranked against the previous 500 four-hour bars. Bottom third = low, top third = high.',
    read: 'Methods often work only in one volatility state — stops get hit in wild markets, targets are too far in quiet ones.',
    good: 'Positive expectancy in low, normal and high volatility.',
  },
  regimeMatrix: {
    what: 'Every combination of trend and volatility, with expectancy and trade count per cell.',
    read: 'Green cells earn money, red cells lose it; the stronger the color, the larger the effect. Use it to design filters — for example "skip ranging, high-volatility markets".',
    good: 'No strong red cell with a meaningful number of trades.',
    watch: 'Small cells (a handful of trades) are mostly noise. Do not build rules from them.',
  },
  significance: {
    what: 'A one-sided t-test on the per-trade results: how likely is an average this good if the true edge were zero?',
    read: 'The p-value is that probability. The t-statistic is the edge measured in standard errors.',
    good: 'p below 0.05 (95% confidence), ideally below 0.01. A t-statistic above 2 is the same idea.',
    watch: 'Testing many variations and keeping the best one inflates significance — the deflated Sharpe ratio corrects for that.',
  },
  bootstrapCI: {
    what: 'A 95% confidence interval for the expectancy, built by resampling the trades 2,000 times.',
    read: 'The bar shows the range where the true expectancy most likely lies. The further the whole bar sits to the right of zero, the safer the edge.',
    good: 'The lower end above zero.',
  },
  sharpeConfidence: {
    what: 'Probabilistic Sharpe ratio (PSR): the probability that the true per-trade Sharpe is above zero, allowing for skew and fat tails. Minimum track record length (MinTRL): how many trades are needed for 95% confidence. Deflated Sharpe ratio (DSR): the PSR after correcting for the number of backtests you ran. Skew and kurtosis describe the shape of the results.',
    read: 'Read PSR and DSR as probabilities. "Trades still needed" turns MinTRL into a to-do. Positive skew means occasional big winners; kurtosis above 3 means fat tails.',
    good: 'PSR above 95%, DSR above 90%, and no trades still needed.',
    watch: 'Every session with 10+ trades counts as a trial for the DSR, so trying many ideas lowers it — that is the point.',
  },
  friction: {
    what: 'The results re-calculated with extra cost on every trade: +1 and +2 cost units, where 1 unit is 1 pip or 0.01% of the price, whichever is larger.',
    read: 'This simulates wider spreads and slippage. Break-even cost is how many units per trade would wipe out the whole profit.',
    good: 'Still clearly profitable at +2 units; break-even above 2 units.',
    watch: 'Scalping methods with small targets are the most sensitive to costs.',
  },
  outliers: {
    what: 'The record re-measured without its best 5% of trades.',
    read: 'Shows how much of the edge survives without rare windfalls. The share is the remaining expectancy as a % of the full one.',
    good: 'More than half of the edge remains.',
    watch: 'If the edge disappears, the result depends on a few trades you may never see again.',
  },
  execution: {
    what: 'Discipline and trade management: how much of the best open profit winners keep (capture), how many trades had a stop loss, and how consistent the % risked per trade was.',
    read: 'Low capture means profits are given back before exit. Missing stops and erratic sizing make results hard to repeat.',
    good: 'Capture above 50%, a stop on every trade, and a risk CV below 0.2.',
  },
  mcPaths: {
    what: 'Thousands of possible futures built from your own trades. Bootstrap draws trades at random (with replacement) for the chosen horizon; shuffle reuses every trade exactly once in a random order. Returns compound, like a fixed-% risk account.',
    read: 'The dark band holds the middle 50% of outcomes, the light band 90%; the line is the median. The tiles show the chance of profit, typical drawdowns and the longest losing streaks.',
    good: 'Even the 5th-percentile path ends above the start.',
    watch: 'Monte Carlo assumes future trades look like past ones. Use "skip trades" and "extra cost" to stress-test missed signals and worse fills.',
  },
  mcDrawdown: {
    what: 'The distribution of the maximum drawdown across all simulated paths.',
    read: 'Bars to the right are rarer but possible. The 95th percentile is a sensible "plan for this" drawdown.',
    good: 'The 95th percentile drawdown is one you could sit through without changing the rules.',
  },
  mcRuin: {
    what: 'The probability of hitting a drawdown of 10%, 20%, 30% and 50% within the simulated horizon.',
    read: 'Pick the level that would end your account or your confidence (a prop firm\'s max loss, for example) and read its probability.',
    good: 'Under 5% for the level that matters to you, under 1% for 50%.',
  },
  mcSizing: {
    what: 'The same strategy simulated at different risk-per-trade levels (0.25% to 3%), using the results in risk units.',
    read: 'Higher risk raises the median return but drawdowns grow faster than returns. The highlighted row is the largest risk whose 95th-percentile drawdown stays within 20% with less than 1% chance of a 50% drawdown.',
    good: 'Use the highlighted row or lower.',
    watch: 'Past a certain point more risk lowers the median result (volatility drag). Never size above that point.',
  },
  mcProp: {
    what: 'A day-by-day simulation of a funded-account evaluation. Each simulated day takes its number of trades from your real trades-per-day pattern (including days without trades) and each trade from your results, at the chosen risk.',
    read: 'Pass = target reached after the minimum trading days. Fail daily / total = a loss limit was hit. Unfinished = neither within the time limit.',
    good: 'A pass rate above 50% with failures well below it.',
    watch: 'Real challenges also punish rule breaks this simulation cannot see (news trading, weekend holds).',
  },
  breakdowns: {
    what: 'Results grouped by day of week, hour, trading session, symbol, side, setup tag, exit reason, holding time, order type, month and trading psychology (after a win or loss, Nth trade of the day).',
    read: 'Switch the metric to compare net result, average R, win rate or trade count. Look for groups that consistently lose — they are candidates for a filter.',
    good: 'No large group with a clearly negative result.',
    watch: 'Groups with few trades are noise. Confirm a pattern on new data before acting on it.',
  },
  rDist: {
    what: 'How the trade results are distributed in R multiples (multiples of the amount risked).',
    read: 'A healthy method has losses bunched near −1R (stops respected) and a right tail of winners.',
    good: 'Few results below −1R; meaningful wins at +2R and beyond.',
    watch: 'Bars far left of −1R mean stops were skipped or slipped badly.',
  },
  maeMfe: {
    what: 'Each trade\'s maximum adverse excursion (how far it went against you) against its maximum favourable excursion (how far it went your way), in R.',
    read: 'Winners far to the right of the diagonal moved a lot in your favour; losers with a large MFE were winners that turned around.',
    good: 'Winners with small MAE (clean entries) and few losers that were once well in profit.',
    watch: 'Many losers with MAE just under 1R suggest stops a little too tight.',
  },
  leftOnTable: {
    what: 'The best open profit of each trade (MFE) against what it actually closed for.',
    read: 'Points near the diagonal captured most of the move; points far below it gave profit back.',
    good: 'Winners close to the diagonal.',
  },
  holdVsResult: {
    what: 'How long each trade was held against its result.',
    read: 'Shows whether time in the trade helps or hurts. Long-held losers often mean stops are moved or not used.',
    good: 'Losers closed quickly; winners allowed to run.',
  },
  tradeLog: {
    what: 'Every closed trade in this view. Click a column to sort and a row to open the trade (chart snapshot, notes, tags, rating).',
    read: 'Use it to review the biggest winners and losers, and to journal what you learned.',
    good: 'Notes and tags on most trades — they power the setup breakdowns.',
  },
} satisfies Record<string, Explain>;

export type ExplainId = keyof typeof EXPLAIN;
