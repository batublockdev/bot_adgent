import { getSystemPrompt, TradingDecision } from './decision';
import { getMemorySummary } from './memory';
import { walletClient, agentAccount } from './client';
import { getAllowanceContextForLLM } from './allowanceManager';
import { createPublicClient, http, Address, formatUnits, parseAbi } from 'viem';
import { celo } from 'viem/chains';
import { MINIMAL_ACCOUNT } from './executor';

// ============ TOKENS ============

export const TOKENS: Record<string, `0x${string}`> = {
  wARS:       '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D',
  USDC:       '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  USDT:       '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
  wBRL:       '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0',
  EURm:       '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73',
  CHFm:       '0xb55a79F398E759E43C95b979163f30eC87Ee131D',
  GBPm:       '0xCCF663b1fF11028f0b19058d0f7B674004a40746',
  CELO:       '0x471EcE3750Da237f93B8E339c536989b8978a438',
  WBTC:       '0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D',
  WETH:       '0xD221812de1BD094f35587EE8E174B07B6167D9Af',
  TetherGold: '0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff',
  SUSHI:      '0xD15EC721C2A896512Ad29C671997DD68f9593226',
  ETHIX:      '0x9995cc8F20Db5896943Afc8eE0ba463259c931ed',
  PLASTIK:    '0x27cd006548dF7C8c8e9fdc4A67fa05C2E3CA5CF9',
};

// ============ AAVE V3 ============

const AAVE_POOL: Address = '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402';

// aTokens (reciben yield) — extraídos de getReserveData on-chain
const A_TOKENS: Record<string, { address: Address; decimals: number }> = {
  USDT: { address: '0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df', decimals: 6 },
  USDC: { address: '0xE15324a9887999803b931Ac45aa89a94A9750052', decimals: 6 },
  WETH: { address: '0xf385280F36e009C157697D25E0B802EfaBfd789c', decimals: 18 },
  WBTC: { address: '0x8B62d241Bf59f40991DCd18531683156d7013355', decimals: 8 },
};

// Variable debt tokens (lo que se debe) — extraídos de getReserveData on-chain
const VAR_DEBT_TOKENS: Record<string, { address: Address; decimals: number }> = {
  WETH: { address: '0x6508cff7c5FbA053Af00a4E894500e6fA00274B7', decimals: 18 },
  USDT: { address: '0x444E85e29F3417E0Df6B697bfDfE5E9A96B550e5', decimals: 6 },
  USDC: { address: '0x7e16eeBAC3276515EDD0BC54E7241668eF015E33', decimals: 6 },
  WBTC: { address: '0x4d6F11B7C4f6bA9C9bA2D3A3C4f8c7B6e1E5d9A3', decimals: 8 },
};

const AAVE_POOL_ABI = parseAbi([
  'function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrows, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);

const publicClient = createPublicClient({
  chain: celo,
  transport: http('https://forno.celo.org'),
});

// ============ TIPOS ============

interface AavePosition {
  token: string;
  supplied: string;
  debt: string;
}

interface PortfolioState {
  walletBalances: Record<string, string>;
  contractPositions: AavePosition[];
  aavePositions: AavePosition[];
  healthFactor: string;
  totalCollateral: string;
  totalDebt: string;
  totalValue: string;
  level: 'alto' | 'medio' | 'bajo';
}

interface MarketData {
  prices: Record<string, string>;
  textileFXRates: Record<string, string>;
  poolTVLs: Record<string, string>;
}

// ============ LECTURA DE AAVE ============

async function getAavePositions(): Promise<{
  positions: AavePosition[];
  healthFactor: string;
  totalCollateral: string;
  totalDebt: string;
}> {
  const positionsMap: Record<string, AavePosition> = {};

  // Leer aToken balances (supply)
  for (const [symbol, info] of Object.entries(A_TOKENS)) {
    try {
      const balance = await publicClient.readContract({
        address: info.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [MINIMAL_ACCOUNT],
      });

      const formatted = formatUnits(balance as bigint, info.decimals);

      if (!positionsMap[symbol]) {
        positionsMap[symbol] = { token: symbol, supplied: '0', debt: '0' };
      }
      positionsMap[symbol].supplied = formatted;
    } catch {
      // aToken may fail — skip
    }
  }

  // Leer variable debt token balances (borrow)
  for (const [symbol, info] of Object.entries(VAR_DEBT_TOKENS)) {
    try {
      const balance = await publicClient.readContract({
        address: info.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [MINIMAL_ACCOUNT],
      });

      const formatted = formatUnits(balance as bigint, info.decimals);

      if (!positionsMap[symbol]) {
        positionsMap[symbol] = { token: symbol, supplied: '0', debt: '0' };
      }
      positionsMap[symbol].debt = formatted;
    } catch {
      // debtToken may fail — skip
    }
  }

  // Filter positions with supply > 0 or debt > 0
  const positions = Object.values(positionsMap).filter(
    p => parseFloat(p.supplied) > 0 || parseFloat(p.debt) > 0
  );

  // Read Health Factor and totals
  let healthFactor = '0';
  let totalCollateral = '0';
  let totalDebt = '0';

  try {
    const accountData = await publicClient.readContract({
      address: AAVE_POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [MINIMAL_ACCOUNT],
    });

    const [
      totalCollateralBase,
      totalDebtBase,
      ,
      ,
      ,
      hf,
    ] = accountData as readonly bigint[];

    totalCollateral = formatUnits(totalCollateralBase, 8); // base in USD (8 decimals)
    totalDebt = formatUnits(totalDebtBase, 8);
    healthFactor = formatUnits(hf, 18);
  } catch {
    // If it fails, leave defaults
  }

  return { positions, healthFactor, totalCollateral, totalDebt };
}

// ============ CONTEXT BUILDER ============

const TOKEN_DECIMALS_MAP: Record<string, number> = {
  USDC: 6, USDT: 6, WBTC: 8, TetherGold: 6,
  wARS: 18, wBRL: 18, CELO: 18, WETH: 18,
  SUSHI: 18, ETHIX: 18, PLASTIK: 18,
  EURm: 6, CHFm: 6, GBPm: 6,
};

export async function buildContext(
  level: 'alto' | 'medio' | 'bajo',
  portfolio: PortfolioState,
  marketData: MarketData,
  rules: string
) {
  const systemPrompt = getSystemPrompt(level);
  const memorySummary = await getMemorySummary();
  const allowanceContext = await getAllowanceContextForLLM(TOKENS, TOKEN_DECIMALS_MAP);

  // Aave positions
  const aave = await getAavePositions();

  const aaveStr = aave.positions.length > 0
    ? aave.positions.map(p =>
        `  ${p.token}: supply=${p.supplied} | debt=${p.debt}`
      ).join('\n')
    : '  No Aave positions';

  const currentState = `
AGENT WALLET: ${agentAccount.address}
AUTONOMY LEVEL: ${level.toUpperCase()}

MINIMAL ACCOUNT BALANCES (idle — not invested):
${Object.entries(portfolio.walletBalances)
  .filter(([_, b]) => parseFloat(b) > 0)
  .map(([token, balance]) => `  ${token}: ${balance}`)
  .join('\n') || '  No idle balances'}

AAVE V3 POSITIONS:
${aaveStr}

HEALTH FACTOR: ${aave.healthFactor}
TOTAL COLLATERAL: ${aave.totalCollateral} USD
TOTAL DEBT: ${aave.totalDebt} USD

${allowanceContext}
`;

  const marketDataStr = `
CURRENT PRICES:
${Object.entries(marketData.prices).map(([pair, price]) => `  ${pair}: ${price}`).join('\n')}

RATES:
${Object.entries(marketData.textileFXRates).map(([pair, rate]) => `  ${pair}: ${rate}`).join('\n')}

POOL TVLs:
${Object.entries(marketData.poolTVLs).map(([pool, tvl]) => `  ${pool}: ${tvl}`).join('\n')}
`;

  const rulesStr = rules || getDefaultRules(level);

  return {
    systemPrompt,
    currentState,
    marketData: marketDataStr,
    history: memorySummary,
    rules: rulesStr,
    userPrompt: getDefaultUserPrompt(level),
  };
}

function getDefaultRules(level: 'alto' | 'medio' | 'bajo'): string {
  switch (level) {
    case 'alto':
      return `
LEVEL HIGH RULES:
- No asset restrictions
- You can operate Uniswap V3 and Aave V3 freely
- Health Factor must be > 1.5 before borrow
- If HF < 1.3, repay immediately
- Diversify — not everything in one asset
- Idle money = wasted money`;

    case 'medio':
      return `
LEVEL MEDIUM RULES:
- Max 30% allocation per asset
- No borrow (supply and swap only)
- Health Factor doesn't apply (no debt)
- Diversify among stablecoins`;

    case 'bajo':
      return `
LEVEL LOW RULES:
- Only USDT and USDC
- Fixed allocation: 50/50
- Only supply on Aave (no borrow, no swaps to crypto)
- If there's wBRL, swap to USDT and supply`;
  }
}

function getDefaultUserPrompt(level: 'alto' | 'medio' | 'bajo'): string {
  const prompts = {
    alto: 'Analyze idle balances, Aave positions, and decide the best strategy to maximize returns. If there is idle money, invest it. You have full freedom.',
    medio: 'Analyze the portfolio and propose an operation within the rules. Supply and swaps between stablecoins only.',
    bajo: 'Check if there are idle balances to swap to USDT and supply on Aave. Nothing else.',
  };
  return prompts[level];
}

export type { PortfolioState, MarketData, AavePosition };