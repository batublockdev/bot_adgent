import { createPublicClient, http, Address, parseAbi, formatUnits } from 'viem';
import { celo } from 'viem/chains';
import type { MarketData } from './context';
import dotenv from 'dotenv';

dotenv.config();

const CELO_RPC = process.env.CELO_RPC || 'https://forno.celo.org';

const PUBLIC_CLIENT = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC),
});

// ============ POOLS DE UNISWAP V3 EN CELO ============

export interface PoolInfo {
  tokenA: string;
  tokenB: string;
  fee: number;
  poolAddress: Address;
  token0: string;
  token1: string;
}

export const POOLS: PoolInfo[] = [
  {
    tokenA: 'wBRL',
    tokenB: 'USDT',
    fee: 100,
    poolAddress: '0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F',
    token0: 'USDT',
    token1: 'wBRL',
  },
  {
    tokenA: 'CELO',
    tokenB: 'USDT',
    fee: 100,
    poolAddress: '0x6cde5f5a192fBf3fD84df983aa6DC30dbd9f8Fac',
    token0: 'CELO',
    token1: 'USDT',
  },
  {
    tokenA: 'WETH',
    tokenB: 'USDT',
    fee: 3000,
    poolAddress: '0x6F42B9D2085a0dEb711C00A460a98B9863ae4897',
    token0: 'USDT',
    token1: 'WETH',
  },
  {
    tokenA: 'WBTC',
    tokenB: 'USDT',
    fee: 3000,
    poolAddress: '0x57332c214E647063bB4c5A73e5A8b7bbA79Be1E4',
    token0: 'USDT',
    token1: 'WBTC',
  },
  {
    tokenA: 'USDC',
    tokenB: 'USDT',
    fee: 100,
    poolAddress: '0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846',
    token0: 'USDT',
    token1: 'USDC',
  },
];

// ============ TOKENS ============

export const TOKENS: Record<string, { address: Address; decimals: number }> = {
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
  WBTC: { address: '0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D', decimals: 8 },
  WETH: { address: '0xD221812de1BD094f35587EE8E174B07B6167D9Af', decimals: 18 },
  wBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', decimals: 18 },
  CELO: { address: '0x471EcE3750Da237f93B8E339c536989b8978a438', decimals: 18 },
};

// ============ ABIs ============

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
]);

// ============ LECTURA DE PRECIOS ON-CHAIN ============

/**
 * Calcula el precio de tokenA en términos de USDT usando slot0 de Uniswap V3.
 */
export async function getPriceFromPool(pool: PoolInfo): Promise<string | null> {
  try {
    const [sqrtPriceX96] = await PUBLIC_CLIENT.readContract({
      address: pool.poolAddress,
      abi: POOL_ABI,
      functionName: 'slot0',
    }) as readonly bigint[];

    if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return null;

    const decimals0 = TOKENS[pool.token0]?.decimals ?? 18;
    const decimals1 = TOKENS[pool.token1]?.decimals ?? 18;

    const sqrt = Number(sqrtPriceX96) / (2 ** 96);
    const p1per0 = (sqrt * sqrt) * Math.pow(10, decimals0 - decimals1);

    if (p1per0 <= 0 || !isFinite(p1per0)) return null;

    let priceInUSDT: number;
    if (pool.tokenA === pool.token0) {
      // token0 es tokenA y token1 es USDT -> p1per0 es USDT por tokenA
      priceInUSDT = p1per0;
    } else {
      // token1 es tokenA y token0 es USDT -> p1per0 es tokenA por USDT -> 1 / p1per0 es USDT por tokenA
      priceInUSDT = 1 / p1per0;
    }

    if (priceInUSDT <= 0 || !isFinite(priceInUSDT)) return null;

    return priceInUSDT < 1 ? priceInUSDT.toFixed(4) : priceInUSDT.toFixed(2);
  } catch (error) {
    console.warn(`[marketData] Error leyendo pool on-chain ${pool.tokenA}/${pool.tokenB}:`, error);
    return null;
  }
}

/**
 * Oráculo de respaldo: DeFiLlama API pública gratuita (sin API key)
 */
async function fetchFallbackPrices(): Promise<Record<string, string>> {
  try {
    const addresses = Object.entries(TOKENS)
      .map(([, info]) => `celo:${info.address}`)
      .join(',');

    const res = await fetch(`https://coins.llama.fi/prices/current/${addresses}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return {};

    const data = await res.json() as { coins?: Record<string, { price: number; symbol: string }> };
    const coins = data.coins || {};

    const fallbackPrices: Record<string, string> = {};
    for (const [symbol, info] of Object.entries(TOKENS)) {
      const key = `celo:${info.address}`;
      if (coins[key]?.price) {
        const p = coins[key].price;
        fallbackPrices[`${symbol}/USDT`] = p < 1 ? p.toFixed(4) : p.toFixed(2);
      }
    }
    return fallbackPrices;
  } catch {
    return {};
  }
}

/**
 * Obtiene los precios de todos los tokens soportados contra USDT
 */
export async function getAllPrices(): Promise<Record<string, string>> {
  const prices: Record<string, string> = {
    'USDT/USDT': '1.00',
  };

  // 1. Consultar pools on-chain en paralelo
  const poolPromises = POOLS.map(async (pool) => {
    const price = await getPriceFromPool(pool);
    return { pair: `${pool.tokenA}/USDT`, price };
  });

  const poolResults = await Promise.all(poolPromises);
  for (const { pair, price } of poolResults) {
    if (price) {
      prices[pair] = price;
    }
  }

  // 2. Si falta algún precio crítico, completar con oráculo de respaldo
  const missingCritical = ['CELO/USDT', 'wBRL/USDT', 'WETH/USDT', 'WBTC/USDT'].some((p) => !prices[p]);
  if (missingCritical) {
    console.log('[marketData] Obteniendo precios complementarios desde oráculo de respaldo...');
    const fallbacks = await fetchFallbackPrices();
    for (const [pair, price] of Object.entries(fallbacks)) {
      if (!prices[pair]) {
        prices[pair] = price;
      }
    }
  }

  // Asegurar par USDT/USDC si tenemos USDC/USDT
  if (prices['USDC/USDT']) {
    const num = parseFloat(prices['USDC/USDT']);
    prices['USDT/USDC'] = num > 0 ? (1 / num).toFixed(4) : '1.0000';
  }

  return prices;
}

/**
 * Obtiene los TVL aproximados leyendo balances de USDT en las pools
 */
export async function getPoolTVLs(): Promise<Record<string, string>> {
  const tvls: Record<string, string> = {};
  const usdtAddress = TOKENS.USDT.address;

  for (const pool of POOLS) {
    try {
      const usdtBalance = await PUBLIC_CLIENT.readContract({
        address: usdtAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [pool.poolAddress],
      }) as bigint;

      const usdtAmount = Number(formatUnits(usdtBalance, 6));
      // TVL total aproximado = 2x balance del activo quote (USDT)
      const approxTotalUSD = Math.round(usdtAmount * 2);
      if (approxTotalUSD >= 1000) {
        tvls[`${pool.tokenA}/${pool.tokenB}`] = `$${Math.round(approxTotalUSD / 1000)}K`;
      } else {
        tvls[`${pool.tokenA}/${pool.tokenB}`] = `$${approxTotalUSD}`;
      }
    } catch {
      tvls[`${pool.tokenA}/${pool.tokenB}`] = 'N/A';
    }
  }

  return tvls;
}

/**
 * Función principal que devuelve la estructura MarketData completa con datos reales
 */
export async function getMarketData(): Promise<MarketData> {
  const [prices, poolTVLs] = await Promise.all([
    getAllPrices(),
    getPoolTVLs(),
  ]);

  const wbrlPrice = parseFloat(prices['wBRL/USDT'] || '0.20');
  const usdtPerWbrl = wbrlPrice > 0 ? (1 / wbrlPrice).toFixed(2) : '5.00';

  const textileFXRates: Record<string, string> = {
    'wBRL→USDT': `1 wBRL = ${wbrlPrice.toFixed(4)} USDT`,
    'USDT→wBRL': `1 USDT = ${usdtPerWbrl} wBRL`,
  };

  return {
    prices,
    textileFXRates,
    poolTVLs,
  };
}

export { PUBLIC_CLIENT };
