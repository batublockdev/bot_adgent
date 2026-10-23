import { createPublicClient, http, Address, parseAbi, formatUnits } from 'viem';
import { celo } from 'viem/chains';

const PUBLIC_CLIENT = createPublicClient({
  chain: celo,
  transport: http('https://forno.celo.org'),
});

// ============ POOLS DE UNISWAP V3 EN CELO ============

// Pools confirmadas con su dirección real y fee
interface PoolInfo {
  tokenA: string;
  tokenB: string;
  fee: number;
  poolAddress: Address;
  // token0 es el que tiene address menor
  token0: string;
  token1: string;
}

const POOLS: PoolInfo[] = [
  {
    tokenA: 'wBRL',
    tokenB: 'USDT',
    fee: 100,
    poolAddress: '0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F',
    token0: 'USDT', // 0x4806... < 0xD76f...
    token1: 'wBRL',
  },
  // Más pools se pueden agregar conforme se confirmen
];

// ============ TOKENS ============

const TOKENS: Record<string, { address: Address; decimals: number }> = {
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
  WBTC: { address: '0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D', decimals: 8 },
  WETH: { address: '0xD221812de1BD094f35587EE8E174B07B6167D9Af', decimals: 18 },
  wBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', decimals: 18 },
  CELO: { address: '0x471EcE3750Da237f93B8E339c536989b8978a438', decimals: 18 },
};

// ============ ABI ============

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
]);

// ============ PRECIOS DESDE SLOT0 ============

/**
 * Lee sqrtPriceX96 de una pool y calcula el precio
 * price = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
 * Esto da: cuántas unidades de token1 por 1 unidad de token0
 */
export async function getPriceFromPool(
  poolAddress: Address,
  token0Symbol: string,
  token1Symbol: string
): Promise<string | null> {
  try {
    const [sqrtPriceX96] = await PUBLIC_CLIENT.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'slot0',
    }) as readonly bigint[];

    if (sqrtPriceX96 === 0n) return null;

    const decimals0 = TOKENS[token0Symbol]?.decimals ?? 18;
    const decimals1 = TOKENS[token1Symbol]?.decimals ?? 18;

    // price = (sqrtPriceX96^2 / 2^192) * 10^(decimals0 - decimals1)
    // Para evitar overflow con BigInt, usamos Number con suficientes dígitos
    const sqrtStr = sqrtPriceX96.toString();
    const sqrtNum = Number(sqrtStr) / 1e29; // sqrtPriceX96 es ~1e29 en la pool wBRL/USDT
    const price01 = (sqrtNum * sqrtNum) / (2 ** 192 / 1e58);
    const adjusted = price01 * Math.pow(10, decimals0 - decimals1);

    return adjusted.toFixed(8);
  } catch (error) {
    console.error(`[marketData] Error leyendo pool ${poolAddress}:`, error);
    return null;
  }
}

/**
 * Obtiene el precio de un par buscando en las pools conocidas
 */
export async function getTokenPrice(
  tokenInSymbol: string,
  tokenOutSymbol: string
): Promise<string | null> {
  for (const pool of POOLS) {
    if (
      (pool.tokenA === tokenInSymbol && pool.tokenB === tokenOutSymbol) ||
      (pool.tokenA === tokenOutSymbol && pool.tokenB === tokenInSymbol)
    ) {
      const price01 = await getPriceFromPool(pool.poolAddress, pool.token0, pool.token1);
      if (!price01) return null;

      // price01 = token1 por token0
      if (tokenInSymbol === pool.token0 && tokenOutSymbol === pool.token1) {
        return price01; // token1 por token0 = tokenOut por tokenIn ✅
      } else {
        // Invertir precio
        const num = parseFloat(price01);
        return num > 0 ? (1 / num).toFixed(8) : null;
      }
    }
  }
  return null;
}

/**
 * Obtiene todos los precios disponibles contra USDT (dólar de referencia)
 */
export async function getAllPrices(): Promise<Record<string, string>> {
  const prices: Record<string, string> = {};

  for (const symbol of Object.keys(TOKENS)) {
    if (symbol === 'USDT') {
      prices[`${symbol}/USDT`] = '1.0';
      continue;
    }

    const price = await getTokenPrice(symbol, 'USDT');
    if (price) {
      prices[`${symbol}/USDT`] = price;
    }
  }

  return prices;
}

/**
 * Obtiene todos los datos de mercado para el contexto del LLM
 */
export async function getMarketDataForLLM(): Promise<{
  prices: Record<string, string>;
  poolTVLs: Record<string, string>;
}> {
  const prices = await getAllPrices();

  const poolTVLs: Record<string, string> = {
    'wBRL/USDT': '~$450K (pool 0x01c3cf91...)',
  };

  return { prices, poolTVLs };
}

export { PUBLIC_CLIENT };