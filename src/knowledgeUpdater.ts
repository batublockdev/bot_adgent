/**
 * @title knowledgeUpdater.ts
 * @notice Actualiza la knowledge base del agent con datos reales on-chain.
 * Migrado a PostgreSQL (pg) para deploy en Railway.
 */

import { createPublicClient, http, Address, parseAbi, formatUnits } from 'viem';
import { celo } from 'viem/chains';
import { upsertKnowledge, deleteKnowledge, cleanMarketKnowledge } from './memory';
import pool from './memory';

const publicClient = createPublicClient({
  chain: celo,
  transport: http('https://forno.celo.org'),
});

// ============ DIRECCIONES ============

const AAVE_POOL: Address = '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402';
const MINIMAL_ACCOUNT: Address = '0x74E16132B76Af0B03730F5c4BF540D777b085DDc';

const TOKENS: Record<string, { address: Address; decimals: number }> = {
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
  WBTC: { address: '0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D', decimals: 8 },
  WETH: { address: '0xD221812de1BD094f35587EE8E174B07B6167D9Af', decimals: 18 },
  wBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', decimals: 18 },
  CELO: { address: '0x471EcE3750Da237f93B8E339c536989b8978a438', decimals: 18 },
};

// Pools confirmadas
const POOLS: { pair: string; address: Address; token0: string; token1: string; fee: number }[] = [
  { pair: 'wBRL/USDT', address: '0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F', token0: 'USDT', token1: 'wBRL', fee: 100 },
  { pair: 'CELO/USDT', address: '0x6cde5f5a192fBf3fD84df983aa6DC30dbd9f8Fac', token0: 'CELO', token1: 'USDT', fee: 100 },
  { pair: 'WETH/USDT', address: '0x6F42B9D2085a0dEb711C00A460a98B9863ae4897', token0: 'USDT', token1: 'WETH', fee: 3000 },
  { pair: 'WBTC/USDT', address: '0x57332c214E647063bB4c5A73e5A8b7bbA79Be1E4', token0: 'USDT', token1: 'WBTC', fee: 3000 },
  { pair: 'USDC/USDT', address: '0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846', token0: 'USDT', token1: 'USDC', fee: 100 },
];

// ============ ABIs ============

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint32, bool)',
  'function liquidity() view returns (uint128)',
]);

const AAVE_POOL_ABI = parseAbi([
  'function getReserveData(address) view returns (uint256 unbacked, uint256 liquidityIndex, uint256 variableBorrowIndex, uint256 variableBorrowRate, uint256 utilizationRate, uint256 stableBorrowRate, address aToken, address stableDebtToken, address variableDebtToken, address interestRateStrategy, uint256 accruedToTreasury, uint256 totalATokenSupply, uint256 totalDebt, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 reserveFactor)',
  'function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrows, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);

// ============ HELPERS ============

function sqrtPriceToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const sqrt = Number(sqrtPriceX96);
  const q96 = 2 ** 96;
  const rawPrice = Math.pow(sqrt / q96, 2);
  return rawPrice * Math.pow(10, decimals0 - decimals1);
}

// ============ ACTUALIZACIONES ============

/**
 * Actualiza precios de las pools conocidas
 */
async function updatePrices() {
  for (const pool of POOLS) {
    try {
      const [sqrtPriceX96] = await publicClient.readContract({
        address: pool.address,
        abi: POOL_ABI,
        functionName: 'slot0',
      }) as readonly bigint[];

      const liquidity = await publicClient.readContract({
        address: pool.address,
        abi: POOL_ABI,
        functionName: 'liquidity',
      }) as bigint;

      const decimals0 = TOKENS[pool.token0]?.decimals ?? 18;
      const decimals1 = TOKENS[pool.token1]?.decimals ?? 18;
      const price = sqrtPriceToPrice(sqrtPriceX96, decimals0, decimals1);

      await upsertKnowledge('market', `price_${pool.pair}`,
        `1 ${pool.token0} = ${price.toFixed(6)} ${pool.token1}. Pool fee ${pool.fee}. Liquidez: ${formatUnits(liquidity, 18)}`);

      const token0Info = TOKENS[pool.token0];
      if (token0Info) {
        const balance = await publicClient.readContract({
          address: token0Info.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [pool.address],
        }) as bigint;
        const tvl = formatUnits(balance, token0Info.decimals);
        await upsertKnowledge('market', `tvl_${pool.pair}`, `TVL: ${tvl} ${pool.token0} en pool`);
      }
    } catch (error) {
      console.error(`[knowledgeUpdater] Error updating price ${pool.pair}:`, error);
    }
  }
}

/**
 * Actualiza datos de Aave: APYs, Health Factor del MinimalAccount, posiciones
 */
async function updateAaveData() {
  for (const [symbol, info] of Object.entries(TOKENS)) {
    try {
      const reserveData = await publicClient.readContract({
        address: AAVE_POOL,
        abi: AAVE_POOL_ABI,
        functionName: 'getReserveData',
        args: [info.address],
      }) as any;

      const liquidityRate = reserveData[15] as bigint;
      const apy = (Number(liquidityRate) / 1e27) * 100;

      if (apy > 0) {
        await upsertKnowledge('market', `apy_${symbol}`,
          `Aave APY supply ${symbol}: ${apy.toFixed(2)}%`);
      }

      const borrowRate = reserveData[3] as bigint;
      const borrowApy = (Number(borrowRate) / 1e27) * 100;
      if (borrowApy > 0) {
        await upsertKnowledge('market', `borrow_apy_${symbol}`,
          `Aave APY borrow ${symbol}: ${borrowApy.toFixed(2)}%`);
      }
    } catch {
      // Token puede no estar en Aave — skip
    }
  }

  try {
    const accountData = await publicClient.readContract({
      address: AAVE_POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [MINIMAL_ACCOUNT],
    }) as readonly bigint[];

    const totalCollateral = formatUnits(accountData[0], 8);
    const totalDebt = formatUnits(accountData[1], 8);
    const healthFactor = formatUnits(accountData[5], 18);

    await upsertKnowledge('market', 'aave_position',
      `MinimalAccount en Aave — Colateral: ${totalCollateral} USD | Deuda: ${totalDebt} USD | Health Factor: ${healthFactor}`);
  } catch {
    // Sin posición en Aave todavía
  }
}

/**
 * Actualiza balances del MinimalAccount
 */
async function updateBalances() {
  for (const [symbol, info] of Object.entries(TOKENS)) {
    try {
      const balance = await publicClient.readContract({
        address: info.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [MINIMAL_ACCOUNT],
      }) as bigint;

      const formatted = formatUnits(balance, info.decimals);
      if (parseFloat(formatted) > 0) {
        await upsertKnowledge('market', `balance_${symbol}`,
          `MinimalAccount balance ${symbol}: ${formatted} (${info.decimals} decimals)`);
      } else {
        await deleteKnowledge('market', `balance_${symbol}`);
      }
    } catch {
      // skip
    }
  }

  try {
    const balance = await publicClient.getBalance({ address: MINIMAL_ACCOUNT });
    const formatted = formatUnits(balance, 18);
    if (parseFloat(formatted) > 0) {
      await upsertKnowledge('market', 'balance_CELO_native',
        `MinimalAccount CELO nativo: ${formatted} (gas)`);
    }
  } catch {
    // skip
  }
}

// ============ FUNCIÓN PRINCIPAL ============

/**
 * Ejecuta todas las actualizaciones de la knowledge base.
 */
export async function updateKnowledgeBase() {
  console.log('[knowledgeUpdater] Updating knowledge base...');
  try {
    await Promise.all([
      updatePrices(),
      updateAaveData(),
      updateBalances(),
    ]);
    const res = await pool.query("SELECT COUNT(*) as c FROM knowledge WHERE category = 'market'");
    const count = res.rows[0]?.c || 0;
    console.log(`[knowledgeUpdater] ✅ Knowledge base updated (${count} market entries)`);
  } catch (error) {
    console.error('[knowledgeUpdater] ❌ Error:', error);
  }
}

export { cleanMarketKnowledge };

export default { updateKnowledgeBase, cleanMarketKnowledge };