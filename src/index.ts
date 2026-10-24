import { makeDecision } from './decision';
import { buildContext, TOKENS } from './context';
import type { PortfolioState, MarketData } from './context';
import { saveTrade, saveDecision, savePerformance, getLatestPerformance, initDB, closeDB } from './memory';
import { walletClient, agentAccount } from './client';
import { createPublicClient, http, formatUnits } from 'viem';
import { celo } from 'viem/chains';
import {
  executeDecision as executeViaMinimalAccount,
  getAllMinimalAccountBalances,
  getMinimalAccountCeloBalance,
  MINIMAL_ACCOUNT,
} from './executor';
import { getAllowanceContextForLLM, getAllAllowances, SPENDERS } from './allowanceManager';
import { updateKnowledgeBase } from './knowledgeUpdater';
import { getMarketData } from './marketData';

// ============ CONFIGURATION ============

const AGENT_LEVEL: 'alto' | 'medio' | 'bajo' = 'alto';
const LOOP_INTERVAL_MS = 10 * 60 * 60 * 1000; // 10 hours
const MAX_CONFIDENCE_THRESHOLD = 70;

// Minimum threshold to operate — below this, HOLD
// Gas on Celo costs ~0.001-0.01 USD. Operating less than this loses money.
const MIN_OPERATION_AMOUNT_USD = 0.50;

// Per-token thresholds (in token units)
const MIN_AMOUNTS: Record<string, number> = {
  USDT: 0.50,
  USDC: 0.50,
  wBRL: 3.0,
  WETH: 0.0002,
  WBTC: 0.00001,
  CELO: 0.5,
};

const publicClient = createPublicClient({
  chain: celo,
  transport: http('https://forno.celo.org'),
});

const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6, USDT: 6, WBTC: 8, TetherGold: 6,
  wARS: 18, wBRL: 18, CELO: 18, WETH: 18,
  SUSHI: 18, ETHIX: 18, PLASTIK: 18,
  EURm: 6, CHFm: 6, GBPm: 6,
};

async function getWalletBalances(): Promise<Record<string, string>> {
  const balances = await getAllMinimalAccountBalances(TOKENS, TOKEN_DECIMALS);
  balances['CELO_native'] = await getMinimalAccountCeloBalance();
  return balances;
}


async function getPortfolio(level: 'alto' | 'medio' | 'bajo'): Promise<PortfolioState> {
  const walletBalances = await getWalletBalances();
  // TODO: read Aave positions (aToken balances, debt, Health Factor)
  return {
    walletBalances,
    contractPositions: [],
    aavePositions: [],
    healthFactor: "0",
    totalCollateral: "0",
    totalDebt: "0",
    totalValue: '0',
    level,
  };
}

// ============ EXECUTION ============

async function executeDecision(decision: any, level: 'alto' | 'medio' | 'bajo'): Promise<string> {
  if (decision.action === 'hold') {
    return 'Hold — no action needed';
  }

  if (decision.action === 'request_setup') {
    return `⚠️ NEEDS_SETUP: ${decision.reason}\n   Batu, you need to do this from your wallet.`;
  }

  console.log(`[LEVEL ${level.toUpperCase()}] Executing: ${decision.action} ${decision.amount || ''} ${decision.tokenIn || ''} → ${decision.tokenOut || ''}`);

  const result = await executeViaMinimalAccount(decision, TOKENS, TOKEN_DECIMALS);

  if (result.success) {
    return `✅ Executed: ${result.action} | TX: ${result.txHash || 'N/A'}`;
  } else {
    return `❌ Error: ${result.error}`;
  }
}

// ============ MAIN LOOP ============

async function runCycle(level: 'alto' | 'medio' | 'bajo') {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[${new Date().toISOString()}] Cycle — Level: ${level.toUpperCase()}`);
  console.log(`${'='.repeat(50)}\n`);

  try {
    // 0. UPDATE KNOWLEDGE BASE (prices, APYs, positions)
    await updateKnowledgeBase();

    // 1. PERCEPTION
    console.log('📡 Gathering data...');
    const [portfolio, marketData] = await Promise.all([
      getPortfolio(level),
      getMarketData(),
    ]);

    console.log(`Wallet: ${agentAccount.address}`);
    console.log(`MinimalAccount: ${MINIMAL_ACCOUNT}`);
    console.log('Balances:', portfolio.walletBalances);

    // 2. CONTEXT
    console.log('🧠 Building context...');
    const ctx = await buildContext(level, portfolio, marketData, '');

    // 3. DECISION
    console.log('🤖 Sending to LLM...');
    const decision = await makeDecision(ctx);

    console.log(`\n📌 Decision: ${decision.action.toUpperCase()}`);
    if (decision.tokenIn && decision.tokenOut) {
      console.log(`   ${decision.tokenIn} → ${decision.tokenOut}`);
    } else if (decision.tokenIn) {
      console.log(`   Token: ${decision.tokenIn}`);
    }
    if (decision.fee) console.log(`   Fee: ${decision.fee}`);
    console.log(`   Amount: ${decision.amount || 'N/A'}`);
    console.log(`   Confidence: ${decision.confidence}%`);
    console.log(`   Reason: ${decision.reason}`);

    // 4. SAVE DECISION
    await saveDecision(decision);

    // 5. EXECUTE
    // Check minimum threshold — don't operate with amounts that only spend gas
    const decisionAmount = parseFloat(decision.amount || '0');
    const tokenSym = decision.tokenIn || decision.asset || '';
    const minAmount = MIN_AMOUNTS[tokenSym] || 0;
    const isBelowMin = decisionAmount > 0 && decisionAmount < minAmount;

    if (isBelowMin && decision.action !== 'hold') {
      console.log(`\n⏸️ Auto HOLD — amount ${decisionAmount} ${tokenSym} < minimum ${minAmount} (gas > return)`);
      decision.action = 'hold';
      decision.reason = `Amount too small (${decisionAmount} ${tokenSym}) — gas cost > potential return. Holding.`;
    }

    const shouldExecute =
      decision.action === 'request_setup' ||
      decision.action === 'request_approval' ||
      (decision.action !== 'hold' && decision.confidence >= MAX_CONFIDENCE_THRESHOLD);

    if (shouldExecute) {
      console.log(`\n⚡ Executing...`);
      const result = await executeDecision(decision, level);
      console.log(result);

      // Save trade if executed
      if (!result.includes('NEEDS_APPROVAL') && !result.includes('NEEDS_SETUP') && decision.action !== 'hold') {
        await saveTrade({
          action: decision.action,
          asset: decision.tokenIn || decision.tokenOut || decision.asset,
          amount: decision.amount,
          level: decision.level,
          reason: decision.reason,
          confidence: decision.confidence,
        });
      }
    } else if (decision.action !== 'hold') {
      console.log(`\n⏸️ Not executing — confidence ${decision.confidence}% < ${MAX_CONFIDENCE_THRESHOLD}%`);
    } else {
      console.log(`\n⏸️ Hold`);
    }

    // 6. PERFORMANCE
    const perf = await getLatestPerformance();
    await savePerformance({
      total_value: portfolio.totalValue,
      total_pnl: perf?.total_pnl || '0',
      win_rate: perf?.win_rate || '0',
      trade_count: perf?.trade_count || 0,
    });

  } catch (error) {
    console.error('❌ Error in cycle:', error);
  }
}

// ============ START ============

async function main() {
  console.log('🚀 Celo Investment Agent starting...');

  // Initialize DB (create tables if they don't exist)
  await initDB();
  console.log(`📍 Agent Wallet: ${agentAccount.address}`);
  console.log(`📦 MinimalAccount: ${MINIMAL_ACCOUNT}`);
  console.log(`🧠 LLM: Ollama Cloud (con fallback a Google Gemini)`);
  console.log(`🌐 Network: Celo mainnet (42220)`);
  console.log(`📊 Level: ${AGENT_LEVEL.toUpperCase()}`);
  console.log(`⏱️ Interval: ${LOOP_INTERVAL_MS / 1000}s\n`);

  await runCycle(AGENT_LEVEL);
  setInterval(() => runCycle(AGENT_LEVEL), LOOP_INTERVAL_MS);
}

main().catch(console.error);

// Close DB cleanly on exit
process.on('SIGTERM', async () => {
  console.log('[SIGTERM] Closing connections...');
  await closeDB();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('[SIGINT] Closing connections...');
  await closeDB();
  process.exit(0);
});