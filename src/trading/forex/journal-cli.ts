import { getArg, getNumArg, hasFlag } from '../../utils/args.js';
import { runMain } from '../../utils/process.js';
import {
  formatDecision,
  formatSummary,
  generateSummary,
  getDecisionsByCycle,
  getDecisionsBySymbol,
  getDecisionsByType,
  getRecentDecisions,
} from './decision-journal.js';

// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
  const hours = getNumArg('hours') ?? 24;
  const symbol = getArg('symbol');
  const cycle = getArg('cycle');
  const type = getArg('type') as 'entry' | 'skip' | 'manage' | 'exit' | undefined;
  const showSummary = hasFlag('summary') || hasFlag('diary');
  const count = getNumArg('count') ?? 20;

  if (showSummary) {
    const summary = generateSummary(hours);
    console.log(formatSummary(summary));
    return;
  }

  let decisions;

  if (cycle) {
    decisions = getDecisionsByCycle(cycle);
  } else if (symbol) {
    decisions = getDecisionsBySymbol(symbol.toUpperCase(), hours);
  } else if (type) {
    decisions = getDecisionsByType(type, hours);
  } else if (hasFlag('last')) {
    decisions = getRecentDecisions(1);
  } else {
    decisions = getRecentDecisions(count);
  }

  if (decisions.length === 0) {
    console.log('Нет решений за указанный период.');
    return;
  }

  for (const d of decisions) {
    console.log(formatDecision(d));
    console.log('---');
  }

  console.log(`\nВсего: ${decisions.length} решений`);
}

runMain(main);
