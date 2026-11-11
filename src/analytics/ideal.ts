import type { ExplainId } from './explain';

/** Which mini-drawing illustrates the ideal (see ui/an-ideal.ts). */
export type IdealKind =
  | 'gauge' | 'bars' | 'checklist' | 'tiles' | 'line' | 'underwater' | 'payoff' | 'hist' | 'streak'
  | 'monthPair' | 'monthGrid' | 'zeroLine' | 'halves' | 'regimeBars' | 'regimeGrid' | 'interval'
  | 'costBars' | 'fan' | 'ddHist' | 'ruin' | 'sizing' | 'scatter' | 'capture' | 'hold' | 'log';

export interface Ideal {
  kind: IdealKind;
  /** caption under the ideal drawing */
  good: string;
  /** caption under the weak drawing */
  bad: string;
  /** why the ideal shape is the one to aim for */
  why: string;
}

/** The ideal picture for every "How to read" guide. Thresholds match explain.ts and score.ts. */
export const IDEAL: Record<ExplainId, Ideal> = {
  score: { kind: 'gauge', good: '80+ · all-weather', bad: 'Below 50',
    why: 'A high score means every part of the test agrees: it earns, it survives drawdowns, it works in different markets and the sample is large enough. One strong number alone can be luck; seven that agree rarely are.' },
  pillars: { kind: 'bars', good: 'All pillars above 70', bad: 'One pillar far behind',
    why: 'A method fails at its weakest point, not its average. Even bars mean there is no hidden weakness waiting for the wrong market.' },
  gates: { kind: 'checklist', good: 'No flags', bad: 'Capped by a flag',
    why: 'Each flag marks a way a good-looking test can still be unsafe (too few trades, one lucky trade, a deep drawdown). Clearing them all means the score is not hiding a deal-breaker.' },
  kpis: { kind: 'tiles', good: '+0.2R or more · PF 1.5+ · DD under 20%', bad: 'High win rate, negative expectancy',
    why: 'Expectancy and profit factor say whether each trade is worth taking; drawdown says whether you can stay in the game long enough to collect it. Win rate alone says neither.' },
  challenge: { kind: 'checklist', good: 'Target hit, limits untouched', bad: 'A loss limit breached',
    why: 'Passing with room to spare shows the risk per trade fits the rules. Passing by a hair usually fails on the next attempt.' },
  equity: { kind: 'line', good: 'Steady staircase', bad: 'Flat, then one jump',
    why: 'A smooth rise means the profit comes from many ordinary trades, so it is likely to repeat. A curve made by one or two big trades depends on events you cannot plan for.' },
  drawdown: { kind: 'underwater', good: 'Shallow, quick recovery', bad: 'Deep and long',
    why: 'Shallow, short drawdowns are easy to sit through, so you keep following the rules. Deep or long ones are where traders abandon a method just before it recovers.' },
  keystats: { kind: 'payoff', good: 'Wins larger than losses', bad: 'Losses larger than wins',
    why: 'When the average win is clearly bigger than the average loss, the method stays profitable even if the win rate drops. That margin is what protects you in a bad month.' },
  riskAdjusted: { kind: 'gauge', good: 'Sharpe above 1, Calmar above 1', bad: 'Return bought with big swings',
    why: 'Return per unit of risk shows how much pain each dollar of profit costs. A high ratio lets you size up safely; a low one means the same profit needs a much bigger drawdown.' },
  tailRisk: { kind: 'hist', good: 'Worst losses near −1R', bad: 'Losses far past the stop',
    why: 'When the worst trades stay close to the planned risk, a bad day is survivable and position sizing can be trusted. A long left tail means one trade can undo weeks of work.' },
  streaks: { kind: 'streak', good: 'Streak near what chance predicts', bad: 'Much longer than chance',
    why: 'A streak no longer than chance predicts means losses are spread out randomly. A much longer one means losses cluster in certain market phases the method cannot handle.' },
  monthlyRule: { kind: 'monthPair', good: 'Worst month smaller than an average month', bad: 'Worst month erases several',
    why: 'If one bad month costs less than a normal month earns, you recover in about a month. That keeps the account and your confidence intact.' },
  monthlyTable: { kind: 'monthGrid', good: 'Mostly green, small reds', bad: 'Reds bunched together',
    why: 'Profits spread over many months show the edge does not depend on one season or one market move.' },
  rolling: { kind: 'zeroLine', good: 'Stays above zero, no downtrend', bad: 'Fading below zero',
    why: 'A line that stays above zero means the edge was present through the whole test. A line sinking at the end warns that the market may have changed.' },
  halves: { kind: 'halves', good: 'Both halves similar', bad: 'Only one half earns',
    why: 'An edge that shows up in both halves was not a product of one market phase. Similar size means it is stable, not fading.' },
  calendar: { kind: 'monthGrid', good: 'Many small green days', bad: 'One day dominates',
    why: 'Many small wins mean the result comes from routine, not from a single lucky day you may never see again.' },
  regimeTrend: { kind: 'regimeBars', good: 'Positive in up, down and range', bad: 'Loses when the market ranges',
    why: 'Markets switch between trending and ranging without warning. A method that earns in all three does not need you to predict the regime.' },
  regimeVol: { kind: 'regimeBars', good: 'Positive in calm and wild markets', bad: 'Only works in one state',
    why: 'Volatility decides whether stops and targets are sized right. Positive results in every state mean your stops and targets adapt well.' },
  regimeMatrix: { kind: 'regimeGrid', good: 'No strong red cell', bad: 'A red cell with many trades',
    why: 'A strong red cell is a known condition where the method loses. With none, there is no condition you must avoid.' },
  significance: { kind: 'interval', good: 'p below 0.05', bad: 'Could be luck',
    why: 'A low p-value means an average this good would be rare if there were no edge. It is the difference between a result and a coincidence.' },
  bootstrapCI: { kind: 'interval', good: 'Whole range above zero', bad: 'Range crosses zero',
    why: 'If even the low end of the range is positive, the method is likely profitable even in an unlucky run of the same trades.' },
  sharpeConfidence: { kind: 'gauge', good: 'PSR above 95%', bad: 'Not enough trades yet',
    why: 'A high probability here means the edge survives after allowing for a short sample, fat tails and the number of ideas you tried.' },
  friction: { kind: 'costBars', good: 'Still profitable at +2 cost', bad: 'Gone after +1 cost',
    why: 'Live trading always costs more than a backtest: wider spreads, slippage, late fills. An edge that survives extra cost has room for that.' },
  outliers: { kind: 'halves', good: 'Most of the edge remains', bad: 'Edge gone without the top 5%',
    why: 'If the method still earns without its best trades, it does not rely on rare windfalls. That is what makes next month look like last month.' },
  execution: { kind: 'checklist', good: 'Stop on every trade, even risk', bad: 'Missing stops, erratic size',
    why: 'Consistent execution is what makes a backtest repeatable. If size and stops vary, the result measures your mood, not the method.' },
  mcPaths: { kind: 'fan', good: 'Even the unlucky path ends up', bad: 'Unlucky path ends below start',
    why: 'When the 5th-percentile path still ends above the start, the method makes money even with bad luck in the order of trades.' },
  mcDrawdown: { kind: 'ddHist', good: 'Drawdowns bunched at small values', bad: 'Long tail of deep drawdowns',
    why: 'You will meet a drawdown worse than the one in your test. If the 95th percentile is one you can sit through, you will not be forced to quit.' },
  mcRuin: { kind: 'ruin', good: 'Under 5% at your limit', bad: 'Likely to hit the limit',
    why: 'A low chance of reaching the drawdown that would end your account means you get enough trades for the edge to play out.' },
  mcSizing: { kind: 'sizing', good: 'Risk at or below the highlighted row', bad: 'Past the peak',
    why: 'Returns grow in a straight line with risk, but drawdowns grow faster. The highlighted row is where extra risk stops paying for itself.' },
  mcProp: { kind: 'ruin', good: 'Pass rate above 50%', bad: 'Fails more than it passes',
    why: 'A pass rate above half means the challenge fee is a good bet with this risk setting. Below that, lower the risk per trade.' },
  breakdowns: { kind: 'regimeBars', good: 'No large losing group', bad: 'One group drains the result',
    why: 'When every hour, day and setup earns, there is nothing to filter out. One large losing group is a rule you can add: stop trading it.' },
  rDist: { kind: 'hist', good: 'Wall at −1R, tail to the right', bad: 'Losses past −1R',
    why: 'Losses stacked at −1R show stops were respected. A tail of +2R and beyond is what pays for them.' },
  maeMfe: { kind: 'scatter', good: 'Winners barely went against you', bad: 'Losers were once in profit',
    why: 'Winners with little adverse move mean entries are well timed. Losers that had been in profit point to missing profit protection.' },
  leftOnTable: { kind: 'capture', good: 'Closes near the best price', bad: 'Gave most of it back',
    why: 'Points near the diagonal kept most of the move the market offered, so your exits are doing their job.' },
  holdVsResult: { kind: 'hold', good: 'Losers short, winners long', bad: 'Losers held longest',
    why: 'Cutting losers fast and letting winners run is what creates a payoff above 1. The opposite pattern means hoping instead of following the stop.' },
  tradeLog: { kind: 'log', good: 'Notes and tags on most trades', bad: 'Empty journal',
    why: 'Tags turn the log into data: they let the breakdowns show which setups earn. Notes are how you find the mistakes numbers cannot show.' },
};
