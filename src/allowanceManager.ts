/**
 * @title allowanceManager.ts
 * @notice Manages ALL permissions del MinimalAccount en Celo mainnet.
 *
 * The MinimalAccount has 3 layers de permisos that the OWNER must configure:
 *   1. registerTarget(address) — qué contracts pueden ser llamados
 *   2. registerSelector(bytes4, uint256) — qué funciones pueden ejecutarse
 *   3. setAllowedAddress(address) — qué addresses pueden ser recipient en approve/permit
 *
 * Después de esos 3, el agente puede ejecutar approves y swaps via execute().
 */

import { createPublicClient, http, Address, Hex, parseAbi, formatUnits } from 'viem';
import { celo } from 'viem/chains';
import { MINIMAL_ACCOUNT } from './executor';

// ============ CONFIGURACIÓN ============

const CELO_RPC = 'https://forno.celo.org';

const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC),
});

// ============ SPENDERS CONOCIDOS ============

// Direcciones de contracts que pueden spender tokens del MinimalAccount
export const SPENDERS: Record<string, Address> = {
  UNIVERSAL_ROUTER: '0xe2023F3FA515cF070e07fD9d51c1d236e07843f4',
  PERMIT2:          '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  AAVE_POOL:        '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402',
};

// ============ ABI ============

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

// MinimalAccount ABI to read permissions on-chain
const MINIMAL_ACCOUNT_ABI = parseAbi([
  'function isAllowedTarget(address) view returns (bool)',
  'function isSelectorSupported(bytes4) view returns (bool)',
  'function isAllowedAddress(address) view returns (bool)',
  'function functionAddressOffsets(bytes4) view returns (uint256)',
  'function owner() view returns (address)',
  'function getIVerifier() view returns (address)',
]);

// ============ SELECTORES CRÍTICOS ============

// Selectors the MinimalAccount needs tener registrados para operar
export const CRITICAL_SELECTORS: Record<string, { selector: Hex; offset: number; description: string }> = {
  APPROVE: {
    selector: '0x095ea7b3',
    offset: 0,
    description: 'approve(address spender, uint256 amount) — ERC20 approve',
  },
  UNIVERSAL_ROUTER_EXECUTE: {
    selector: '0x3593564c',
    offset: 256,
    description: 'execute(bytes commands, bytes[] inputs, uint256 deadline) — Universal Router swap',
  },
  PERMIT2_PERMIT: {
    selector: '0x87517c45',
    offset: 0,
    description: 'permit(address token, address spender, uint160 amount, uint48 expiration) — Permit2',
  },
  AAVE_SUPPLY: {
    selector: '0x617ba037',
    offset: 64,
    description: 'supply(address,uint256,address,uint16) — Aave V3 supply',
  },
  AAVE_WITHDRAW: {
    selector: '0x69328dec',
    offset: 64,
    description: 'withdraw(address,uint256,address) — Aave V3 withdraw',
  },
  AAVE_BORROW: {
    selector: '0xa415bcad',
    offset: 128,
    description: 'borrow(address,uint256,uint256,uint16,address) — Aave V3 borrow',
  },
  AAVE_REPAY: {
    selector: '0x573ade81',
    offset: 96,
    description: 'repay(address,uint256,uint256,address) — Aave V3 repay',
  },
};

// ============ TIPOS ============

export interface AllowanceStatus {
  spenderName: string;
  spenderAddress: Address;
  tokenSymbol: string;
  tokenAddress: Address;
  currentAllowance: string;
  isApproved: boolean;
  needsApproval: boolean;
}

export interface SpenderStatus {
  name: string;
  address: Address;
  description: string;
  tokensApproved: string[];
  tokensPending: string[];
}

export interface MinimalAccountPermissions {
  // Paso 1: Targets registrados
  targets: { address: Address; name: string; isRegistered: boolean }[];
  // Paso 2: Selectores registrados
  selectors: { selector: Hex; name: string; isRegistered: boolean; offset: number }[];
  // Paso 3: Allowed addresses
  allowedAddresses: { address: Address; name: string; isAllowed: boolean }[];
  // Paso 4: Allowances ERC20
  allowances: AllowanceStatus[];
  // Resumen de qué falta
  missingSteps: { step: number; description: string }[];
}

// ============ LECTURA DE ALLOWANCES ============

/**
 * Lee el allowance de un token hacia un spender desde el MinimalAccount
 */
export async function getTokenAllowance(
  tokenAddress: Address,
  spenderAddress: Address,
  decimals: number = 18
): Promise<string> {
  try {
    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [MINIMAL_ACCOUNT, spenderAddress],
    });
    return formatUnits(allowance as bigint, decimals);
  } catch (error) {
    console.error(`Error leyendo allowance de ${tokenAddress} → ${spenderAddress}:`, error);
    return '0';
  }
}

/**
 * Verifica si un spender está approved para un token
 * Un allowance > 0 significa que está approved
 */
export async function isApproved(
  tokenAddress: Address,
  spenderAddress: Address
): Promise<boolean> {
  try {
    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [MINIMAL_ACCOUNT, spenderAddress],
    });
    return (allowance as bigint) > 0n;
  } catch {
    return false;
  }
}

/**
 * Lee todos los allowances del MinimalAccount hacia los spenders conocidos
 * para una lista de tokens dada
 */
export async function getAllAllowances(
  tokens: Record<string, `0x${string}`>,
  decimalsMap: Record<string, number>
): Promise<AllowanceStatus[]> {
  const results: AllowanceStatus[] = [];

  for (const [spenderName, spenderAddress] of Object.entries(SPENDERS)) {
    for (const [tokenSymbol, tokenAddress] of Object.entries(tokens)) {
      const allowance = await getTokenAllowance(
        tokenAddress as Address,
        spenderAddress,
        decimalsMap[tokenSymbol] || 18
      );

      const isApp = parseFloat(allowance) > 0;

      results.push({
        spenderName,
        spenderAddress,
        tokenSymbol,
        tokenAddress: tokenAddress as Address,
        currentAllowance: allowance,
        isApproved: isApp,
        needsApproval: !isApp,
      });
    }
  }

  return results;
}

/**
 * Returns a readable summary del estado de permisos por spender
 */
export async function getSpenderStatuses(
  tokens: Record<string, `0x${string}`>,
  decimalsMap: Record<string, number>
): Promise<SpenderStatus[]> {
  const allowances = await getAllAllowances(tokens, decimalsMap);

  const statuses: SpenderStatus[] = [];

  for (const [spenderName, spenderAddress] of Object.entries(SPENDERS)) {
    const relevant = allowances.filter(a => a.spenderName === spenderName);

    const descriptions: Record<string, string> = {
      UNIVERSAL_ROUTER: 'Router de Uniswap para ejecutar swaps en Celo',
      PERMIT2: 'Contract de permits de Uniswap para token approvals',
    };

    statuses.push({
      name: spenderName,
      address: spenderAddress,
      description: descriptions[spenderName] || 'Spender desconocido',
      tokensApproved: relevant.filter(a => a.isApproved).map(a => a.tokenSymbol),
      tokensPending: relevant.filter(a => a.needsApproval).map(a => a.tokenSymbol),
    });
  }

  return statuses;
}

// ============ LECTURA DE PERMISOS DEL MINIMAL ACCOUNT ============

/**
 * PASO 1: Verifies if a target is registered en el MinimalAccount
 */
export async function isTargetRegistered(targetAddress: Address): Promise<boolean> {
  try {
    const result = await publicClient.readContract({
      address: MINIMAL_ACCOUNT,
      abi: MINIMAL_ACCOUNT_ABI,
      functionName: 'isAllowedTarget',
      args: [targetAddress],
    });
    return result as boolean;
  } catch {
    return false;
  }
}

/**
 * PASO 2: Verifies if a selector is registered en el MinimalAccount
 */
export async function isSelectorRegistered(selector: Hex): Promise<boolean> {
  try {
    const result = await publicClient.readContract({
      address: MINIMAL_ACCOUNT,
      abi: MINIMAL_ACCOUNT_ABI,
      functionName: 'isSelectorSupported',
      args: [selector],
    });
    return result as boolean;
  } catch {
    return false;
  }
}

/**
 * PASO 3: Verifies if an address is authorized como allowedAddress
 */
export async function isAllowedAddress(addr: Address): Promise<boolean> {
  try {
    const result = await publicClient.readContract({
      address: MINIMAL_ACCOUNT,
      abi: MINIMAL_ACCOUNT_ABI,
      functionName: 'isAllowedAddress',
      args: [addr],
    });
    return result as boolean;
  } catch {
    return false;
  }
}

/**
 * Lee TODOS los permisos del MinimalAccount on-chain:
 * - Paso 1: Targets registrados
 * - Paso 2: Selectores registrados
 * - Paso 3: Allowed addresses
 * - Paso 4: Allowances ERC20
 */
export async function getAllMinimalAccountPermissions(
  tokens: Record<string, `0x${string}`>,
  decimalsMap: Record<string, number>
): Promise<MinimalAccountPermissions> {
  // Targets we need to register para operar
  const targetsToCheck = [
    { address: SPENDERS.UNIVERSAL_ROUTER, name: 'UNIVERSAL_ROUTER' },
    { address: SPENDERS.PERMIT2, name: 'PERMIT2' },
    { address: SPENDERS.AAVE_POOL, name: 'AAVE_POOL' },
    ...Object.entries(tokens).map(([symbol, addr]) => ({
      address: addr as Address,
      name: symbol,
    })),
  ];

  // Selectors we need to register para operar
  const selectorsToCheck = Object.entries(CRITICAL_SELECTORS).map(([name, info]) => ({
    selector: info.selector as Hex,
    name,
    offset: info.offset,
  }));

  // Addresses we need to authorize como allowedAddress
  const addressesToCheck = [
    { address: SPENDERS.UNIVERSAL_ROUTER, name: 'UNIVERSAL_ROUTER' },
    { address: SPENDERS.PERMIT2, name: 'PERMIT2' },
    { address: SPENDERS.AAVE_POOL, name: 'AAVE_POOL' },
  ];

  // Leer todo on-chain en paralelo
  const targetResults = await Promise.all(
    targetsToCheck.map(async t => ({
      address: t.address,
      name: t.name,
      isRegistered: await isTargetRegistered(t.address),
    }))
  );

  const selectorResults = await Promise.all(
    selectorsToCheck.map(async s => ({
      selector: s.selector,
      name: s.name,
      offset: s.offset,
      isRegistered: await isSelectorRegistered(s.selector),
    }))
  );

  const addressResults = await Promise.all(
    addressesToCheck.map(async a => ({
      address: a.address,
      name: a.name,
      isAllowed: await isAllowedAddress(a.address),
    }))
  );

  const allowances = await getAllAllowances(tokens, decimalsMap);

  // Calculate what is missing
  const missingSteps: { step: number; description: string }[] = [];

  const missingTargets = targetResults.filter(t => !t.isRegistered);
  if (missingTargets.length > 0) {
    missingSteps.push({
      step: 1,
      description: `Missing registered targets: ${missingTargets.map(t => `${t.name} (${t.address})`).join(', ')}`,
    });
  }

  const missingSelectors = selectorResults.filter(s => !s.isRegistered);
  if (missingSelectors.length > 0) {
    missingSteps.push({
      step: 2,
      description: `Missing registered selectors: ${missingSelectors.map(s => `${s.name} (${s.selector})`).join(', ')}`,
    });
  }

  const missingAddresses = addressResults.filter(a => !a.isAllowed);
  if (missingAddresses.length > 0) {
    missingSteps.push({
      step: 3,
      description: `Missing authorized addresses: ${missingAddresses.map(a => `${a.name} (${a.address})`).join(', ')}`,
    });
  }

  const missingAllowances = allowances.filter(a => a.needsApproval);
  if (missingAllowances.length > 0) {
    missingSteps.push({
      step: 4,
      description: `Missing ERC20 approves: ${missingAllowances.map(a => `${a.tokenSymbol} → ${a.spenderName}`).join(', ')}`,
    });
  }

  return {
    targets: targetResults,
    selectors: selectorResults,
    allowedAddresses: addressResults,
    allowances,
    missingSteps,
  };
}

/**
 * Generates the full permissions text para el LLM
 * Incluye los 4 pasos del flow del MinimalAccount
 */
export async function getAllowanceContextForLLM(
  tokens: Record<string, `0x${string}`>,
  decimalsMap: Record<string, number>
): Promise<string> {
  const perms = await getAllMinimalAccountPermissions(tokens, decimalsMap);

  const lines: string[] = [
    '========================================',
    'PERMISOS DEL MINIMAL ACCOUNT ON-CHAIN',
    '========================================',
    `MinimalAccount: ${MINIMAL_ACCOUNT}`,
    '',
    'STEP 1: REGISTERED TARGETS (isAllowedTarget)',
    '----------------------------------------',
  ];

  for (const t of perms.targets) {
    lines.push(`  ${t.isRegistered ? '✅' : '❌'} ${t.name} (${t.address})`);
  }

  lines.push('',
    'STEP 2: REGISTERED SELECTORS (isSelectorSupported)',
    '----------------------------------------');

  for (const s of perms.selectors) {
    lines.push(`  ${s.isRegistered ? '✅' : '❌'} ${s.name} (${s.selector}) offset=${s.offset} — ${CRITICAL_SELECTORS[s.name]?.description || ''}`);
  }

  lines.push('',
    'STEP 3: AUTHORIZED ADDRESSES (isAllowedAddress)',
    '----------------------------------------');

  for (const a of perms.allowedAddresses) {
    lines.push(`  ${a.isAllowed ? '✅' : '❌'} ${a.name} (${a.address})`);
  }

  lines.push('',
    'STEP 4: ERC20 ALLOWANCES (token approve to spender)',
    '----------------------------------------');

  // Mostrar solo tokens con balance o relevantes para wBRL
  const relevantAllowances = perms.allowances.filter(a =>
    a.tokenSymbol === 'wBRL' || a.isApproved
  );
  for (const a of relevantAllowances) {
    lines.push(`  ${a.isApproved ? '✅' : '❌'} ${a.tokenSymbol} → ${a.spenderName} (allowance: ${a.currentAllowance})`);
  }

  lines.push('',
    "SUMMARY OF WHAT'S MISSING",
    '----------------------------------------');

  if (perms.missingSteps.length === 0) {
    lines.push('  ✅ ALL READY — can execute swaps directly');
  } else {
    for (const m of perms.missingSteps) {
      lines.push(`  ⚠️ STEP ${m.step}: ${m.description}`);
    }
  }

  return lines.join('\n');
}

/**
 * Verifica si un swap específico puede ejecutarse
 * Checks the 4 steps del flow
 */
export async function checkSwapPermissions(
  tokenInSymbol: string,
  tokenInAddress: Address,
  amountIn: bigint,
  tokens?: Record<string, `0x${string}`>,
  decimalsMap?: Record<string, number>
): Promise<{ canExecute: boolean; missingSteps: string[]; details: string }> {
  const missing: string[] = [];

  // PASO 1: Token target must be registered
  const targetRegistered = await isTargetRegistered(tokenInAddress);
  if (!targetRegistered) {
    missing.push(`STEP 1: registerTarget(${tokenInSymbol} — ${tokenInAddress})`);
  }

  // PASO 1b: Universal Router must be registered como target
  const routerTarget = await isTargetRegistered(SPENDERS.UNIVERSAL_ROUTER);
  if (!routerTarget) {
    missing.push(`STEP 1: registerTarget(UNIVERSAL_ROUTER — ${SPENDERS.UNIVERSAL_ROUTER})`);
  }

  // PASO 2: Approve selector must be registered
  const approveSelectorOK = await isSelectorRegistered(CRITICAL_SELECTORS.APPROVE.selector);
  if (!approveSelectorOK) {
    missing.push(`STEP 2: registerSelector(0x095ea7b3, 0) — approve`);
  }

  // PASO 2b: Selector execute del Universal Router must be registered
  const routerSelectorOK = await isSelectorRegistered(CRITICAL_SELECTORS.UNIVERSAL_ROUTER_EXECUTE.selector);
  if (!routerSelectorOK) {
    missing.push(`STEP 2: registerSelector(0x3593564c, 256) — Universal Router execute`);
  }

  // PASO 3: Universal Router must be set as allowedAddress
  const routerAllowed = await isAllowedAddress(SPENDERS.UNIVERSAL_ROUTER);
  if (!routerAllowed) {
    missing.push(`STEP 3: setAllowedAddress(UNIVERSAL_ROUTER — ${SPENDERS.UNIVERSAL_ROUTER})`);
  }

  // PASO 3b: Permit2 must be set as allowedAddress
  const permit2Allowed = await isAllowedAddress(SPENDERS.PERMIT2);
  if (!permit2Allowed) {
    missing.push(`STEP 3: setAllowedAddress(PERMIT2 — ${SPENDERS.PERMIT2})`);
  }

  // PASO 4: Token allowance to Universal Router
  const routerAllowance = await publicClient.readContract({
    address: tokenInAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [MINIMAL_ACCOUNT, SPENDERS.UNIVERSAL_ROUTER],
  });
  if ((routerAllowance as bigint) < amountIn) {
    missing.push(`STEP 4: approve ${tokenInSymbol} → UNIVERSAL_ROUTER (current: ${formatUnits(routerAllowance as bigint, 18)})`);
  }

  // PASO 4b: Token allowance to Permit2
  const permit2Allowance = await publicClient.readContract({
    address: tokenInAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [MINIMAL_ACCOUNT, SPENDERS.PERMIT2],
  });
  if ((permit2Allowance as bigint) < amountIn) {
    missing.push(`STEP 4: approve ${tokenInSymbol} → PERMIT2 (current: ${formatUnits(permit2Allowance as bigint, 18)})`);
  }

  return {
    canExecute: missing.length === 0,
    missingSteps: missing,
    details: missing.length === 0
      ? 'All permissions are ready para ejecutar el swap'
      : `Missing steps:\n  ${missing.join('\n  ')}`,
  };
}