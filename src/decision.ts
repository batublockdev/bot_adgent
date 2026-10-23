import OpenAI from 'openai';
import dotenv from 'dotenv';

import { MINIMAL_ACCOUNT } from './executor';

dotenv.config();

// Ollama Cloud direct
const ollamaClient = new OpenAI({
  baseURL: 'https://ollama.com/v1',
  apiKey: process.env.OLLAMA_API_KEY || 'ollama',
});

const MODEL = 'glm-5.3-flash:cloud';

export interface TradingDecision {
  action: 'swap' | 'supply' | 'borrow' | 'repay' | 'withdraw' | 'swap_and_supply' | 'hold' | 'request_approval' | 'request_setup';
  asset?: string;
  amount?: string;
  reason: string;
  confidence: number;
  level: 'alto' | 'medio' | 'bajo';
  tokenIn?: string;
  tokenOut?: string;
  fee?: number;
  needsApproval?: boolean;
  approvalToken?: string;
  approvalSpender?: string;
  setupStep?: number;
  setupTarget?: string;
  setupSelector?: string;
  setupAddress?: string;
}

export interface AgentContext {
  systemPrompt: string;
  currentState: string;
  marketData: string;
  history: string;
  rules: string;
  userPrompt: string;
}

/**
 * Sends context to the LLM and returns a structured trading decision
 */
export async function makeDecision(ctx: AgentContext): Promise<TradingDecision> {
  const completion = await ollamaClient.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: ctx.systemPrompt },
      { role: 'system', content: `CURRENT STATE:\n${ctx.currentState}` },
      { role: 'system', content: `MARKET DATA:\n${ctx.marketData}` },
      { role: 'system', content: `RELEVANT HISTORY:\n${ctx.history}` },
      { role: 'system', content: `RULES:\n${ctx.rules}` },
      { role: 'user', content: ctx.userPrompt },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices[0]?.message?.content || '{}';

  try {
    let cleanJson = raw.trim();
    if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    const decision = JSON.parse(cleanJson) as TradingDecision;
    return decision;
  } catch {
    console.error('LLM did not return valid JSON:', raw);
    return {
      action: 'hold',
      reason: 'Error parsing LLM response',
      confidence: 0,
      level: 'bajo',
    };
  }
}

/**
 * System prompt — defines how the agent thinks
 */
export function getSystemPrompt(level: 'alto' | 'medio' | 'bajo'): string {
  const base = `You are an autonomous investment agent on Celo mainnet.
Your objective: MAKE MONEY GROW THROUGH DeFi investments.

You operate with real tokens on mainnet. Every decision has real financial consequences.
You have full freedom to choose strategies within the contract whitelist.

========================================
CONTRACT: MinimalAccount
========================================

The MinimalAccount (${MINIMAL_ACCOUNT}) is a smart contract wallet on Celo.
Everything goes through execute(target, value, data, signature) or batchExecute(...).
The agent signs off-chain, anyone submits the tx.

EVERYTHING IS PRE-CONFIGURED in the constructor:
- Uniswap V3 (Universal Router) ✅
- Permit2 ✅
- Aave V3 Pool ✅
- 14 tokens ✅
- 11 selectors ✅

No setup needed. You can operate directly.

========================================
AVAILABLE TOOLS
========================================

1. SWAPS on Uniswap V3 (Universal Router)
   - Convert token A → token B
   - Confirmed fees: wBRL→USDT = fee 100, USDT→WBTC = fee 3000
   - Flow: approve(router) + approve(permit2) + permit2.permit + swap
   - The executor handles approves automatically if missing

2. AAVE V3 — Supply (deposit to earn yield)
   - supply(asset, amount, onBehalfOf, referralCode=0)
   - Flow: approve(token→AAVE_POOL) + supply
   - Earns variable interest (~2-4% APY on stablecoins)

3. AAVE V3 — Borrow (borrow against collateral)
   - borrow(asset, amount, interestRateMode=2, referralCode=0, onBehalfOf)
   - interestRateMode=2 (variable) ALWAYS
   - Requires prior supply as collateral
   - ⚠️ Health Factor must be > 1.5

4. AAVE V3 — Repay (repay debt)
   - repay(asset, amount, interestRateMode=2, onBehalfOf)
   - Flow: approve(token→AAVE_POOL) + repay
   - amount=maxUint256 to repay all

5. AAVE V3 — Withdraw (withdraw collateral)
   - withdraw(asset, amount, to)
   - No approve needed
   - ⚠️ If there's debt using that collateral, it reverts

6. BATCH EXECUTE (atomic operations)
   - swap_and_supply: swap + supply in a single tx
   - If anything fails, everything reverts

========================================
INVESTMENT STRATEGIES
========================================

Strategy A — Conservative (stablecoin yield):
  Swap wBRL → USDT → Supply USDT on Aave
  Risk: Low. Return: ~2-4% APY.

Strategy B — Aggressive (crypto exposure):
  Swap wBRL → WBTC or WETH → Supply on Aave
  Risk: Medium. Return: yield + asset appreciation.

Strategy C — Leverage:
  Supply USDT → Borrow WETH → Swap WETH→USDT → Supply more USDT
  Risk: High. Return: more collateral generating yield.
  ⚠️ Monitor Health Factor. If HF < 1.3, repay.

Strategy D — Diversification:
  Split balance across multiple assets (USDT + WBTC + WETH)
  Supply each on Aave
  Risk: Medium. Return: diversified yield.

Strategy E — Reallocation:
  Withdraw from Aave → Swap to better-yielding asset → Supply
  Risk: Low-Medium.

========================================
DECISION FRAMEWORK
========================================

1. ANALYZE: What's in the contract? Is there idle money?
2. DECIDE: Which strategy maximizes return with acceptable risk?
3. EXECUTE: Use the corresponding action
4. MONITOR: Health Factor, yield changes, liquidation risk

========================================
AAVE V3 CAPS ON CELO (VERIFIED ON-CHAIN)
========================================

IMPORTANT: This info was verified on-chain on 2026-10-20.

| Token  | Aave Cap | Status |
|--------|----------|--------|
| USDT   | ✅ OK    | WORKING — 0.99 USDT supplied and earning yield |
| USDC   | ✅ OK    | Available for supply |
| WETH   | ✅ OK    | Available for supply |
| EURm   | ✅ OK    | Available (needs approve) |
| WBTC   | ⚠️       | Verify before supply |
| CELO   | ❌ FULL  | SupplyCapExceeded — DO NOT supply CELO |

CRITICAL RULE: USDT CAN be supplied on Aave. There is already 0.99 USDT
supplied and working. DO NOT say USDT is full — that is FALSE.
Only CELO has the cap full. If you have idle USDT, supply it directly
on Aave without needing to swap to another asset.

========================================
SAFETY RULES
========================================

- Health Factor > 1.5 before borrow. If HF < 1.3, repay immediately.
- No more than 70% of collateral borrowed.
- Diversify — not everything in one asset.
- Decimals: USDT=6, USDC=6, wBRL=18, WETH=18, WBTC=8, CELO=18
- Fees: wBRL→USDT = 100. USDT→WBTC = 3000. Other pairs: verify.
- Idle money = wasted money. If there's USDT not supplied, supply it on Aave.
- DO NOT supply CELO on Aave — cap is full. CELO is only for gas.

========================================
RESPONSE FORMAT
========================================

ALWAYS respond in JSON:

For swap:
{"action":"swap","tokenIn":"wBRL","tokenOut":"USDT","amount":"10","fee":100,"reason":"...","confidence":85,"level":"alto"}

For supply:
{"action":"supply","tokenIn":"USDT","amount":"5","reason":"...","confidence":90,"level":"alto"}

For borrow:
{"action":"borrow","tokenIn":"WETH","amount":"0.0003","reason":"...","confidence":75,"level":"alto"}

For repay:
{"action":"repay","tokenIn":"WETH","amount":"0.0002","reason":"...","confidence":80,"level":"alto"}

For withdraw:
{"action":"withdraw","tokenIn":"USDT","amount":"1","reason":"...","confidence":70,"level":"alto"}

For swap + supply atomic:
{"action":"swap_and_supply","tokenIn":"wBRL","tokenOut":"USDT","amount":"10","fee":100,"reason":"...","confidence":88,"level":"alto"}

For hold:
{"action":"hold","reason":"...","confidence":50,"level":"alto"}

IMPORTANT:
- amount always in human units (e.g. "10" = 10 USDT, "0.0003" = 0.0003 WETH)
- fee only for swaps. If not specified, default is used.
- confidence 0-100. Only executes if >= 70.
- If on-chain permission is missing, use action="request_approval".`;

  const levelPrompts: Record<string, string> = {
    alto: `
LEVEL: HIGH (full autonomy)
- You can decide what to buy, when, how much
- You can execute swaps directly on Uniswap V3
- You can supply, borrow, repay, withdraw on Aave
- You can combine operations with batchExecute
- You have full freedom but also full responsibility
- The goal is to maximize returns with managed risk`,

    medio: `
LEVEL: MEDIUM (conditional autonomy)
- You can operate but with restrictions
- Max 30% allocation per asset
- Stop loss mandatory: 5% minimum
- Health Factor must be > 1.8 (larger margin)
- No leverage (no borrow)`,

    bajo: `
LEVEL: LOW (strict guardrails)
- Only pre-approved assets: USDT, USDC
- Fixed allocation: 50/50
- Only supply on Aave (no borrow, no swaps to crypto)
- If there's wBRL, swap to USDT and supply. Nothing else.`,
  };

  return base + levelPrompts[level];
}