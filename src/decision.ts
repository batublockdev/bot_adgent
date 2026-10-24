import { webcrypto } from 'node:crypto';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';

import { agentAccount } from './client';
import { MINIMAL_ACCOUNT } from './executor';

dotenv.config();

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  console.warn(`[LLM] Web Crypto global unavailable in ${process.version}; using node:crypto.webcrypto`);
}

// ============ CLIENTE X402 / AGENT402 (PROVEEDOR PRIMARIO) ============
// Paga por inferencia con USDC en Celo mainnet mediante x402 v2 ($0.003 / req)
const X402_LLM_URL = process.env.X402_LLM_URL || 'https://agent402.tools/v1/nano';
const X402_MODEL = process.env.X402_MODEL || 'deepseek-chat';
const X402_NANO_MAX_INPUT_CHARS = 11_000;

let x402Client: OpenAI | null = null;
try {
  const signer = toClientEvmSigner(agentAccount);
  const scheme = new ExactEvmScheme(signer);
  const x402Fetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      {
        network: 'eip155:42220', // Celo Mainnet
        client: scheme,
      },
    ],
  });

  x402Client = new OpenAI({
    baseURL: X402_LLM_URL,
    apiKey: process.env.X402_API_KEY || 'x402-wallet',
    fetch: x402Fetch,
  });
} catch (err: any) {
  console.warn(`[LLM] Advertencia: No se pudo instanciar cliente x402: ${err?.message || err}`);
}

// ============ OLLAMA CLOUD (FALLBACK 1) ============
const ollamaClient = new OpenAI({
  baseURL: 'https://ollama.com/v1',
  apiKey: process.env.OLLAMA_API_KEY || 'ollama',
});

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'glm-5.3-flash:cloud';

// ============ GOOGLE GEMINI (FALLBACK 2) ============
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

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
  level?: 'alto' | 'medio' | 'bajo';
}

function extractJsonString(raw: string): string {
  const trimmed = raw.trim();
  // 1. Try markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim();
  }
  // 2. Try first { to last }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1);
  }
  // 3. Try first [ to last ] (in case it returned an array)
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.substring(firstBracket, lastBracket + 1);
  }
  return trimmed;
}

function parseDecisionJson(raw: string, providerName: string, defaultLevel: 'alto' | 'medio' | 'bajo' = 'alto'): TradingDecision {
  try {
    const cleanJson = extractJsonString(raw);
    let parsed: any = JSON.parse(cleanJson);

    // If an array was returned, take the first element
    if (Array.isArray(parsed) && parsed.length > 0) {
      parsed = parsed[0];
    }

    // Unwrap nested objects if model wrapped it (e.g. {"decision": {...}})
    if (parsed && typeof parsed === 'object') {
      const nested = parsed.decision || parsed.trading_decision || parsed.tradingDecision || parsed.result || parsed.response || parsed.data;
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        parsed = { ...parsed, ...nested };
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Parsed result is not an object');
    }

    // Key case-insensitivity & aliases for action
    const rawAction = parsed.action || parsed.Action || parsed.ACTION || parsed.recommendation || parsed.type || parsed.strategy;
    let actionStr = typeof rawAction === 'string' ? rawAction.trim().toLowerCase() : '';

    // Map common synonyms to valid actions
    if (actionStr === 'deposit' || actionStr === 'invest') actionStr = 'supply';
    if (actionStr === 'buy' || actionStr === 'sell') actionStr = 'swap';
    if (actionStr === 'wait' || actionStr === 'do_nothing' || actionStr === 'none' || actionStr === 'idle') actionStr = 'hold';

    const validActions: TradingDecision['action'][] = [
      'swap', 'supply', 'borrow', 'repay', 'withdraw', 'swap_and_supply', 'hold', 'request_approval', 'request_setup'
    ];

    const action: TradingDecision['action'] = validActions.includes(actionStr as any)
      ? (actionStr as TradingDecision['action'])
      : 'hold';

    const tokenIn = parsed.tokenIn || parsed.TokenIn || parsed.token_in || parsed.token || parsed.asset || parsed.Asset;
    const tokenOut = parsed.tokenOut || parsed.TokenOut || parsed.token_out;
    const amount = parsed.amount !== undefined && parsed.amount !== null ? String(parsed.amount) : undefined;
    const fee = typeof parsed.fee === 'number' ? parsed.fee : (parsed.fee ? parseInt(parsed.fee, 10) : undefined);

    let confidence = 50;
    const confVal = parsed.confidence ?? parsed.Confidence;
    if (typeof confVal === 'number' && !isNaN(confVal)) {
      confidence = Math.min(100, Math.max(0, confVal));
    } else if (typeof confVal === 'string' && !isNaN(parseFloat(confVal))) {
      confidence = Math.min(100, Math.max(0, parseFloat(confVal)));
    }

    let reason = parsed.reason || parsed.Reason || parsed.explanation || parsed.rationale || parsed.message;
    if (!reason || typeof reason !== 'string') {
      reason = action === 'hold'
        ? `Sin acción específica identificada de ${providerName}; manteniendo posición (hold).`
        : `Decisión ${action} generada por ${providerName}`;
    }

    let level = parsed.level || parsed.Level || defaultLevel;
    if (!['alto', 'medio', 'bajo'].includes(level)) {
      level = defaultLevel;
    }

    const decision: TradingDecision = {
      action,
      tokenIn: tokenIn ? String(tokenIn) : undefined,
      tokenOut: tokenOut ? String(tokenOut) : undefined,
      asset: parsed.asset ? String(parsed.asset) : (tokenIn ? String(tokenIn) : undefined),
      amount,
      fee,
      confidence,
      reason: String(reason),
      level,
      needsApproval: Boolean(parsed.needsApproval),
      approvalToken: parsed.approvalToken ? String(parsed.approvalToken) : undefined,
      approvalSpender: parsed.approvalSpender ? String(parsed.approvalSpender) : undefined,
      setupStep: typeof parsed.setupStep === 'number' ? parsed.setupStep : undefined,
      setupTarget: parsed.setupTarget ? String(parsed.setupTarget) : undefined,
      setupSelector: parsed.setupSelector ? String(parsed.setupSelector) : undefined,
      setupAddress: parsed.setupAddress ? String(parsed.setupAddress) : undefined,
    };

    return decision;
  } catch (error: any) {
    console.error(`[${providerName}] LLM did not return valid JSON:`, raw);
    console.warn(`[${providerName}] Parse error: ${error?.message || error}`);
    return {
      action: 'hold',
      reason: `Error parsing JSON response from ${providerName}`,
      confidence: 0,
      level: defaultLevel,
    };
  }
}

/**
 * Sends context to the LLM and returns a structured trading decision.
 * First tries Ollama Cloud. If it hits limits or errors, falls back to Google Gemini free tier.
 */
export async function makeDecision(ctx: AgentContext): Promise<TradingDecision> {
  const combinedUserPrompt = `${ctx.userPrompt}\n\nCRITICAL: Respond ONLY with a valid JSON object matching the format: {"action":"swap"|"supply"|"borrow"|"repay"|"withdraw"|"swap_and_supply"|"hold"|"request_approval"|"request_setup","tokenIn":"...","tokenOut":"...","amount":"...","reason":"...","confidence":0-100,"level":"alto"|"medio"|"bajo"}`;

  const createMessages = (
    history: string,
    systemPrompt = ctx.systemPrompt,
  ): OpenAI.Chat.ChatCompletionMessageParam[] => [
    {
      role: 'system',
      content: [
        systemPrompt,
        `CURRENT STATE:\n${ctx.currentState}`,
        `MARKET DATA:\n${ctx.marketData}`,
        `RELEVANT HISTORY:\n${history}`,
        `RULES:\n${ctx.rules}`,
      ].join('\n\n========================================\n\n'),
    },
    { role: 'user', content: combinedUserPrompt },
  ];

  const messages = createMessages(ctx.history);
  const nanoLevelRules: Record<NonNullable<AgentContext['level']>, string> = {
    alto: 'Borrow only when health factor is above 1.5; keep borrowing within 70% of collateral. If health factor is below 1.3, prioritize repay.',
    medio: 'Do not borrow. Limit allocation to 30% per asset; operate only within the supplied rules.',
    bajo: 'Only USDT and USDC; no borrowing or crypto exposure. Supply on Aave; if wBRL is idle, swap it to USDT and supply.',
  };
  const nanoSystemPrompt = [
    `You are a Celo DeFi investment agent. Make a cautious decision using only the live state, market data, and rules provided. Never invent balances, prices, approvals, or capabilities. If data is insufficient or an action is unsafe, return hold.`,
    `Only use supported actions: swap, supply, borrow, repay, withdraw, swap_and_supply, hold, request_approval, request_setup. Use human token units. USDT may be supplied on Aave. Never supply CELO; reserve it for gas.`,
    nanoLevelRules[ctx.level || 'alto'],
    'Follow the supplied RULES and safety limits. Return only the required JSON object with action, tokenIn/tokenOut as applicable, amount, reason, confidence (0-100), and level.',
  ].join('\n');
  let x402Messages = createMessages(ctx.history, nanoSystemPrompt);
  let x402InputChars = JSON.stringify(x402Messages).length;

  if (x402InputChars > X402_NANO_MAX_INPUT_CHARS) {
    const marker = '\n[Earlier and less relevant history omitted to fit the x402 nano input limit.]\n';
    const retainHistory = (length: number): string => {
      if (length === 0) return '';
      const headLength = Math.ceil(length / 2);
      const tailLength = Math.floor(length / 2);
      const tail = tailLength > 0 ? ctx.history.slice(-tailLength) : '';
      return `${ctx.history.slice(0, headLength)}${marker}${tail}`;
    };
    let low = 0;
    let high = ctx.history.length;

    while (low < high) {
      const retained = Math.ceil((low + high) / 2);
      const candidate = createMessages(retainHistory(retained), nanoSystemPrompt);

      if (JSON.stringify(candidate).length <= X402_NANO_MAX_INPUT_CHARS) {
        low = retained;
      } else {
        high = retained - 1;
      }
    }

    x402Messages = createMessages(retainHistory(low), nanoSystemPrompt);
    x402InputChars = JSON.stringify(x402Messages).length;
  }

  // ==========================================
  // 1. INTENTO PRIMARIO: X402 / AGENT402 (PAGO EN USDC EN CELO MAINNET)
  // Modelo: DeepSeek-V3 (deepseek-chat)
  // ==========================================
  let x402Msg = '';

  if (x402Client && X402_LLM_URL) {
    if (x402InputChars > X402_NANO_MAX_INPUT_CHARS) {
      x402Msg = `Required context exceeds the x402 nano limit (${x402InputChars}/${X402_NANO_MAX_INPUT_CHARS} characters) even after removing history`;
      console.warn(`[X402] ${x402Msg}; skipping nano request.`);
    } else {
      const startedAt = Date.now();

      console.log('\n========== DEBUG X402 / AGENT402 ==========');
      console.log('[X402] URL:', X402_LLM_URL);
      console.log('[X402] Modelo:', X402_MODEL);
      console.log('[X402] Cliente disponible:', Boolean(x402Client));
      console.log('[X402] Mensajes:', x402Messages.length);
      console.log('[X402] Entrada x402 nano:', `${x402InputChars}/${X402_NANO_MAX_INPUT_CHARS} caracteres`);
      console.log(
        '[X402] Tamaño aproximado de mensajes:',
        Buffer.byteLength(JSON.stringify(x402Messages), 'utf8'),
        'bytes'
      );

      try {
        console.log('[X402] Enviando solicitud...');

        const completion = await x402Client.chat.completions.create({
          model: X402_MODEL,
          messages: x402Messages,
          temperature: 0.3,
          response_format: { type: 'json_object' },
        });

        console.log('[X402] Solicitud exitosa');
        console.log('[X402] Tiempo:', Date.now() - startedAt, 'ms');
        console.log('[X402] ID:', completion.id);
        console.log('[X402] Modelo devuelto:', completion.model);
        console.log(
          '[X402] Finish reason:',
          completion.choices?.[0]?.finish_reason
        );
        console.log('[X402] Uso:', completion.usage);

        const content = completion.choices?.[0]?.message?.content;
        const raw = typeof content === 'string' ? content : '{}';

        console.log('[X402] Respuesta recibida:\n', raw);

        if (!raw || raw === '{}') {
          console.warn('[X402] La respuesta llegó vacía o sin contenido.');
        }

        return parseDecisionJson(raw, 'x402-DeepSeek', ctx.level);
      } catch (error: unknown) {
        const err = error as {
          name?: string;
          message?: string;
          stack?: string;
          status?: number;
          code?: string;
          type?: string;
          cause?: unknown;
          headers?: unknown;
          error?: unknown;
        };

        x402Msg = err?.message || String(error);

        console.error('\n[X402] ❌ SOLICITUD FALLIDA');
        console.error('[X402] Tiempo hasta el error:', Date.now() - startedAt, 'ms');
        console.error('[X402] Nombre:', err?.name);
        console.error('[X402] Mensaje:', err?.message);
        console.error('[X402] Código:', err?.code);
        console.error('[X402] Tipo:', err?.type);
        console.error('[X402] Estado HTTP:', err?.status);
        console.error('[X402] Causa:', err?.cause);
        console.error('[X402] Error interno:', err?.error);
        console.error('[X402] Stack:', err?.stack);

        // Algunas versiones del SDK exponen estos campos;
        // otras no. No imprimimos cabeceras de pago ni credenciales.
        if (err?.headers) {
          console.error('[X402] Cabeceras disponibles:', err.headers);
        }

        console.warn('[X402] Activando fallback a Ollama Cloud...');
      }
    }

  } else {
    x402Msg = !X402_LLM_URL
      ? 'X402_LLM_URL no configurado'
      : 'x402Client no está inicializado';

    console.error('[X402] No se ejecutó la llamada:', x402Msg);
  }


  // ==========================================
  // 2. FALLBACK 1: OLLAMA CLOUD
  // ==========================================
  let ollamaMsg = '';
  const ollamaKey = process.env.OLLAMA_API_KEY;
  if (ollamaKey && ollamaKey !== 'tu_ollama_api_key') {
    try {
      console.log(`🤖 [LLM] Consultando fallback 1: Ollama Cloud (${OLLAMA_MODEL})...`);
      const completion = await ollamaClient.chat.completions.create({
        model: OLLAMA_MODEL,
        messages,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const raw = completion.choices[0]?.message?.content || '{}';
      console.log(`📥 [Ollama] Respuesta:\n${raw}`);
      return parseDecisionJson(raw, 'Ollama', ctx.level);
    } catch (ollamaError: any) {
      ollamaMsg = ollamaError?.message || String(ollamaError);
      console.warn(`\n⚠️ [LLM] Ollama Cloud falló: ${ollamaMsg}`);
      console.log(`🔄 [LLM] Activando fallback 2 a Google Gemini...`);
    }
  } else {
    ollamaMsg = 'Ollama API key ausente o inválida';
    console.log(`ℹ️ [LLM] Ollama Cloud omitido (${ollamaMsg}). Pasando a Google Gemini...`);
  }

  // ==========================================
  // 3. FALLBACK 2: GOOGLE GEMINI
  // ==========================================
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!geminiApiKey || geminiApiKey === 'tu_gemini_api_key') {
    console.error('❌ [LLM] GEMINI_API_KEY o GOOGLE_API_KEY no encontrada en .env');
    return {
      action: 'hold',
      reason: `Falla en proveedores (x402: ${x402Msg} | Ollama: ${ollamaMsg}) y no hay GEMINI_API_KEY configurada.`,
      confidence: 0,
      level: ctx.level || 'bajo',
    };
  }

  try {
    const geminiClient = new OpenAI({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: geminiApiKey,
    });

    console.log(`🤖 [LLM] Consultando fallback 2: Google Gemini (${GEMINI_MODEL})...`);
    const completion = await geminiClient.chat.completions.create({
      model: GEMINI_MODEL,
      messages,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    console.log(`✅ [LLM] Google Gemini (${GEMINI_MODEL}) respondió exitosamente.`);
    const raw = completion.choices[0]?.message?.content || '{}';
    console.log(`📥 [Gemini] Respuesta:\n${raw}`);
    return parseDecisionJson(raw, 'Gemini', ctx.level);
  } catch (geminiError: any) {
    const geminiMsg = geminiError?.message || String(geminiError);
    console.error(`❌ [LLM] Fallback a Google Gemini también falló: ${geminiMsg}`);
    return {
      action: 'hold',
      reason: `Falla en todos los LLMs (x402: ${x402Msg} | Ollama: ${ollamaMsg} | Gemini: ${geminiMsg})`,
      confidence: 0,
      level: ctx.level || 'bajo',
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