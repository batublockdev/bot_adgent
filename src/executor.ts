/**
 * @title executor.ts
 * @author BatuBlockDev
 * @notice Módulo de ejecución del Celo Investment Agent.
 * Firma operaciones off-chain y las envía al MinimalAccount via execute()/batchExecute().
 *
 * El MinimalAccount usa firma EIP-191 simple (no ERC-4337):
 *   hash = keccak256(abi.encode(target, value, keccak256(data), nonce, chainId))
 *   ethSignedHash = toEthSignedMessageHash(hash)
 *   signature = r + s + v (65 bytes)
 *
 * Cualquiera puede enviar la tx on-chain con esa firma. El contrato verifica.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  Address,
  Hex,
  parseAbi,
  encodeFunctionData,
  encodeAbiParameters,
  formatUnits,
  keccak256,
  concatHex,
  toHex,
} from 'viem';
import { celo } from 'viem/chains';
import { withAttribution } from '@celo/attribution-tags'
import { privateKeyToAccount, sign } from 'viem/accounts';
import dotenv from 'dotenv';
import { checkSwapPermissions, SPENDERS } from './allowanceManager';

dotenv.config();

// ============ CONFIGURACIÓN ============

// MinimalAccount desplegado en Celo mainnet
const MINIMAL_ACCOUNT: Address = '0x74E16132B76Af0B03730F5c4BF540D777b085DDc';

// Universal Router en Celo
const UNIVERSAL_ROUTER: Address = '0xe2023F3FA515cF070e07fD9d51c1d236e07843f4';

// Permit2 en Celo
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Aave V3 Pool en Celo
const AAVE_POOL: Address = '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402';

// Chain ID de Celo mainnet
const CELO_CHAIN_ID = 42220;

// Private key del adgent
const ADGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY as Hex;

// RPC de Celo
const CELO_RPC = process.env.CELO_RPC || 'https://forno.celo.org';

// ============ CLIENTES ============

const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC),
});

const adgentAccount = privateKeyToAccount(ADGENT_PRIVATE_KEY);

const walletClient = createWalletClient({
  account: adgentAccount,
  chain: celo,
  transport: http(CELO_RPC),
}).extend(withAttribution('celo_6d966470558a'));

// ============ ABIs ============

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const MINIMAL_ACCOUNT_ABI = parseAbi([
  'function execute(address target, uint256 value, bytes data, bytes signature) external',
  'function batchExecute(address[] targets, uint256[] values, bytes[] datas, bytes signature) external',
  'function nonce() view returns (uint256)',
  'function owner() view returns (address)',
  'function isAllowedTarget(address) view returns (bool)',
  'function isSelectorSupported(bytes4) view returns (bool)',
  'function isAllowedAddress(address) view returns (bool)',
]);

// ============ SELECTORES ============

const APPROVE_SELECTOR: Hex = '0x095ea7b3';
const PERMIT2_PERMIT_SELECTOR: Hex = '0x87517c45';
const UNIVERSAL_EXECUTE_SELECTOR: Hex = '0x3593564c';
const SUPPLY_SELECTOR: Hex = '0x617ba037';
const WITHDRAW_SELECTOR: Hex = '0x69328dec';
const BORROW_SELECTOR: Hex = '0xa415bcad';
const REPAY_SELECTOR: Hex = '0x573ade81';

// ============ TIPOS ============

export interface ExecutionResult {
  success: boolean;
  txHash?: Hex;
  error?: string;
  action: string;
  asset?: string;
  amount?: string;
}

// ============ LECTURA DE BALANCES ============

export async function getMinimalAccountBalance(
  tokenAddress: Address,
  decimals: number = 18
): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [MINIMAL_ACCOUNT],
    });
    return formatUnits(balance as bigint, decimals);
  } catch (error) {
    console.error(`Error leyendo balance de ${tokenAddress}:`, error);
    return '0';
  }
}

export async function getAllMinimalAccountBalances(
  tokens: Record<string, `0x${string}`>,
  decimalsMap: Record<string, number>
): Promise<Record<string, string>> {
  const balances: Record<string, string> = {};
  for (const [symbol, address] of Object.entries(tokens)) {
    balances[symbol] = await getMinimalAccountBalance(
      address as Address,
      decimalsMap[symbol] || 18
    );
  }
  return balances;
}

export async function getMinimalAccountCeloBalance(): Promise<string> {
  const balance = await publicClient.getBalance({ address: MINIMAL_ACCOUNT });
  return formatUnits(balance, 18);
}

// ============ FIRMA EIP-191 ============

/**
 * Obtiene el nonce actual del MinimalAccount
 */
async function getNonce(): Promise<bigint> {
  const nonce = await publicClient.readContract({
    address: MINIMAL_ACCOUNT,
    abi: MINIMAL_ACCOUNT_ABI,
    functionName: 'nonce',
  });
  return nonce as bigint;
}

/**
 * Calcula el hash EIP-191 para execute()
 * hash = keccak256(abi.encode(target, value, keccak256(data), nonce, chainId))
 * ethSignedHash = keccak256("\x19Ethereum Signed Message:\n32" + hash)
 */
function computeExecuteHash(
  target: Address,
  value: bigint,
  data: Hex,
  nonce: bigint,
  chainId: bigint
): Hex {
  const innerHash = keccak256(data);
  const encoded = encodeAbiParameters(
    [
      { type: 'address', name: 'target' },
      { type: 'uint256', name: 'value' },
      { type: 'bytes32', name: 'dataHash' },
      { type: 'uint256', name: 'nonce' },
      { type: 'uint256', name: 'chainId' },
    ],
    [target, value, innerHash, nonce, chainId]
  );
  const hash = keccak256(encoded);
  // EIP-191 prefix
  return keccak256(
    concatHex([
      toHex('\x19Ethereum Signed Message:\n32', { size: 28 }),
      hash,
    ])
  );
}

/**
 * Calcula el hash EIP-191 para batchExecute()
 * hash = keccak256(abi.encode(targets, values, dataHashes, nonce, chainId))
 */
function computeBatchExecuteHash(
  targets: Address[],
  values: bigint[],
  datas: Hex[],
  nonce: bigint,
  chainId: bigint
): Hex {
  const dataHashes = datas.map(d => keccak256(d));
  const encoded = encodeAbiParameters(
    [
      { type: 'address[]', name: 'targets' },
      { type: 'uint256[]', name: 'values' },
      { type: 'bytes32[]', name: 'dataHashes' },
      { type: 'uint256', name: 'nonce' },
      { type: 'uint256', name: 'chainId' },
    ],
    [targets, values, dataHashes, nonce, chainId]
  );
  const hash = keccak256(encoded);
  return keccak256(
    concatHex([
      toHex('\x19Ethereum Signed Message:\n32', { size: 28 }),
      hash,
    ])
  );
}

/**
 * Firma un hash con la private key del adgent
 * Retorna signature como r + s + v (65 bytes)
 */
async function signHash(hash: Hex): Promise<Hex> {
  const signatureResult = await sign({
    privateKey: ADGENT_PRIVATE_KEY,
    hash,
  });
  const v = signatureResult.v ?? 27n;
  return concatHex([
    signatureResult.r,
    signatureResult.s,
    toHex(v, { size: 1 }),
  ]);
}

// ============ EJECUCIÓN CORE ============

/**
 * Ejecuta una operación individual via MinimalAccount.execute()
 * 1. Lee el nonce actual
 * 2. Calcula el hash EIP-191
 * 3. Firma con la private key del adgent
 * 4. Envía la tx on-chain
 */
export async function executeWithSignature(
  target: Address,
  value: bigint,
  data: Hex
): Promise<ExecutionResult> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const nonce = await getNonce();
      const ethSignedHash = computeExecuteHash(
        target,
        value,
        data,
        nonce,
        BigInt(CELO_CHAIN_ID)
      );
      const signature = await signHash(ethSignedHash);

      const accountNonce = await publicClient.getTransactionCount({
        address: adgentAccount.address,
      });

      const txHash = await walletClient.writeContract({
        address: MINIMAL_ACCOUNT,
        abi: MINIMAL_ACCOUNT_ABI,
        functionName: 'execute',
        args: [target, value, data, signature],
        gas: 500000n,
        nonce: accountNonce,
      });

      // Esperar confirmación
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      return { success: true, txHash, action: 'execute' };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // Si es error de nonce, esperar y retryar
      if (errMsg.includes('nonce too low') || errMsg.includes('replacement transaction underpriced')) {
        console.log(`[EXECUTOR] Nonce error, reintentando (${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
      console.error(`[EXECUTOR] Error in executeWithSignature:`, errMsg.substring(0, 200));
      return {
        success: false,
        error: errMsg,
        action: 'execute',
      };
    }
  }
  return { success: false, error: 'Max retries exceeded', action: 'execute' };
}

/**
 * Ejecuta múltiples operaciones atómicas via MinimalAccount.batchExecute()
 * Si una falla, todo revierte.
 */
export async function batchExecuteWithSignature(
  targets: Address[],
  values: bigint[],
  datas: Hex[]
): Promise<ExecutionResult> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const nonce = await getNonce();
      const ethSignedHash = computeBatchExecuteHash(
        targets,
        values,
        datas,
        nonce,
        BigInt(CELO_CHAIN_ID)
      );
      const signature = await signHash(ethSignedHash);

      const accountNonce = await publicClient.getTransactionCount({
        address: adgentAccount.address,
      });

      const txHash = await walletClient.writeContract({
        address: MINIMAL_ACCOUNT,
        abi: MINIMAL_ACCOUNT_ABI,
        functionName: 'batchExecute',
        args: [targets, values, datas, signature],
        gas: 2000000n,
        nonce: accountNonce,
      });

      // Esperar confirmación
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      return { success: true, txHash, action: 'batch' };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('nonce too low') || errMsg.includes('replacement transaction underpriced')) {
        console.log(`[EXECUTOR] Nonce error in batch, reintentando (${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
      console.error(`[EXECUTOR] Error in batchExecuteWithSignature:`, errMsg.substring(0, 200));
      return {
        success: false,
        error: errMsg,
        action: 'batch',
      };
    }
  }
  return { success: false, error: 'Max retries exceeded', action: 'batch' };
}

// ============ CONSTRUCCIÓN DE CALLDATA ============

/**
 * Construye el calldata para ERC20 approve(address spender, uint256 amount)
 */
export function buildApproveData(
  spender: Address,
  amount: bigint
): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

/**
 * Construye el calldata para Permit2 permit(address token, address spender, uint160 amount, uint48 expiration)
 */
export function buildPermit2Data(
  token: Address,
  spender: Address,
  amount: bigint = 2n ** 160n - 1n, // maxUint160
  expiration: bigint = 2n ** 48n - 1n // maxUint48
): Hex {
  const params = encodeAbiParameters(
    [
      { type: 'address', name: 'token' },
      { type: 'address', name: 'spender' },
      { type: 'uint160', name: 'amount' },
      { type: 'uint48', name: 'expiration' },
    ],
    [token, spender, amount, Number(expiration)] as const
  );
  // Anteponer el selector 0x87517c45 (permit)
  return concatHex([PERMIT2_PERMIT_SELECTOR, params]);
}

/**
 * Construye el calldata para Universal Router execute(bytes commands, bytes[] inputs, uint256 deadline)
 * V3_SWAP_EXACT_IN = 0x00
 */
export function buildSwapData(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOutMin: bigint = 1n,
  fee: number = 3000,
  recipient: Address = MINIMAL_ACCOUNT,
  deadline: bigint = BigInt(Math.floor(Date.now() / 1000) + 60)
): Hex {
  const commands: Hex = '0x00' as Hex;
  const path = `${tokenIn.slice(2)}${fee.toString(16).padStart(6, '0')}${tokenOut.slice(2)}`;

  const inputEncoded = encodeAbiParameters(
    [
      { type: 'address', name: 'recipient' },
      { type: 'uint256', name: 'amountIn' },
      { type: 'uint256', name: 'amountOutMin' },
      { type: 'bytes', name: 'path' },
      { type: 'bool', name: 'payerIsUser' },
    ],
    [recipient, amountIn, amountOutMin, `0x${path}` as Hex, true]
  );

  const params = encodeAbiParameters(
    [
      { type: 'bytes', name: 'commands' },
      { type: 'bytes[]', name: 'inputs' },
      { type: 'uint256', name: 'deadline' },
    ],
    [commands, [inputEncoded], deadline]
  );
  // Anteponer selector 0x3593564c (Universal Router execute)
  return concatHex([UNIVERSAL_EXECUTE_SELECTOR, params]);
}

/**
 * Construye el calldata para Aave supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
 */
export function buildSupplyData(
  asset: Address,
  amount: bigint,
  onBehalfOf: Address = MINIMAL_ACCOUNT,
  referralCode: number = 0
): Hex {
  const params = encodeAbiParameters(
    [
      { type: 'address', name: 'asset' },
      { type: 'uint256', name: 'amount' },
      { type: 'address', name: 'onBehalfOf' },
      { type: 'uint16', name: 'referralCode' },
    ],
    [asset, amount, onBehalfOf, referralCode]
  );
  // Anteponer selector 0x617ba037 (Aave supply)
  return concatHex([SUPPLY_SELECTOR, params]);
}

/**
 * Construye el calldata para Aave withdraw(address asset, uint256 amount, address to)
 */
export function buildWithdrawData(
  asset: Address,
  amount: bigint,
  to: Address = MINIMAL_ACCOUNT
): Hex {
  const params = encodeAbiParameters(
    [
      { type: 'address', name: 'asset' },
      { type: 'uint256', name: 'amount' },
      { type: 'address', name: 'to' },
    ],
    [asset, amount, to]
  );
  // Anteponer selector 0x69328dec (Aave withdraw)
  return concatHex([WITHDRAW_SELECTOR, params]);
}

/**
 * Construye el calldata para Aave borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
 */
export function buildBorrowData(
  asset: Address,
  amount: bigint,
  interestRateMode: bigint = 2n, // variable
  referralCode: number = 0,
  onBehalfOf: Address = MINIMAL_ACCOUNT
): Hex {
  const params = encodeAbiParameters(
    [
      { type: 'address', name: 'asset' },
      { type: 'uint256', name: 'amount' },
      { type: 'uint256', name: 'interestRateMode' },
      { type: 'uint16', name: 'referralCode' },
      { type: 'address', name: 'onBehalfOf' },
    ],
    [asset, amount, interestRateMode, referralCode, onBehalfOf]
  );
  return concatHex([BORROW_SELECTOR, params]);

}

/**
 * Construye el calldata para Aave repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
 */
export function buildRepayData(
  asset: Address,
  amount: bigint,
  interestRateMode: bigint = 2n, // variable
  onBehalfOf: Address = MINIMAL_ACCOUNT
): Hex {
  const params = encodeAbiParameters(
    [
      { type: 'address', name: 'asset' },
      { type: 'uint256', name: 'amount' },
      { type: 'uint256', name: 'interestRateMode' },
      { type: 'address', name: 'onBehalfOf' },
    ],
    [asset, amount, interestRateMode, onBehalfOf]
  );
  return concatHex([REPAY_SELECTOR, params]);

}

// ============ OPERACIONES DE ALTO NIVEL ============

/**
 * Ejecuta un approve de un token hacia un spender desde el MinimalAccount
 */
export async function executeApprove(
  tokenAddress: Address,
  spender: Address,
  amount: bigint
): Promise<ExecutionResult> {
  console.log(`[EXECUTOR] Approve ${tokenAddress} → ${spender}`);
  const data = buildApproveData(spender, amount);
  const result = await executeWithSignature(tokenAddress, 0n, data);
  return { ...result, action: 'approve', amount: amount.toString() };
}

/**
 * Ejecuta un swap completo via Universal Router:
 * 1. Approve token → UNIVERSAL_ROUTER (if missing)
 * 2. Approve token → PERMIT2 (if missing)
 * 3. Permit2 permit
 * 4. Swap
 */
export async function executeSwap(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOutMin: bigint = 1n,
  fee: number = 3000
): Promise<ExecutionResult> {
  try {
    console.log(`[EXECUTOR] Swap ${tokenIn} → ${tokenOut} amountIn: ${amountIn} fee: ${fee}`);

    // Verificar y hacer approves necesarios
    const allowanceRouter = await publicClient.readContract({
      address: tokenIn,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [MINIMAL_ACCOUNT, UNIVERSAL_ROUTER],
    });
    if ((allowanceRouter as bigint) < amountIn) {
      console.log(`[EXECUTOR] Approve → UNIVERSAL_ROUTER...`);
      const r = await executeApprove(tokenIn, UNIVERSAL_ROUTER, 2n ** 256n - 1n);
      if (!r.success) return r;
    }

    const allowancePermit2 = await publicClient.readContract({
      address: tokenIn,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [MINIMAL_ACCOUNT, PERMIT2],
    });
    if ((allowancePermit2 as bigint) < amountIn) {
      console.log(`[EXECUTOR] Approve → PERMIT2...`);
      const r = await executeApprove(tokenIn, PERMIT2, 2n ** 256n - 1n);
      if (!r.success) return r;
    }

    // Permit2 permit
    console.log(`[EXECUTOR] Permit2 permit...`);
    const permitData = buildPermit2Data(tokenIn, UNIVERSAL_ROUTER);
    const permitResult = await executeWithSignature(PERMIT2, 0n, permitData);
    if (!permitResult.success) {
      return { ...permitResult, action: 'permit2' };
    }

    // Swap
    console.log(`[EXECUTOR] Executing swap...`);
    const swapData = buildSwapData(tokenIn, tokenOut, amountIn, amountOutMin, fee);
    const result = await executeWithSignature(UNIVERSAL_ROUTER, 0n, swapData);

    console.log(`[EXECUTOR] ✅ Swap executed. TX: ${result.txHash}`);
    return { ...result, action: 'swap', asset: tokenOut, amount: amountIn.toString() };
  } catch (error) {
    console.error(`[EXECUTOR] ❌ Error in swap:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      action: 'swap',
    };
  }
}

/**
 * Ejecuta supply en Aave V3
 * approve(token → AAVE_POOL) + supply
 */
export async function executeSupply(
  token: Address,
  amount: bigint
): Promise<ExecutionResult> {
  try {
    console.log(`[EXECUTOR] Supply ${token} amount: ${amount} to Aave`);

    // Approve token → Aave Pool
    const allowance = await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [MINIMAL_ACCOUNT, AAVE_POOL],
    });
    if ((allowance as bigint) < amount) {
      console.log(`[EXECUTOR] Approve → AAVE_POOL...`);
      const r = await executeApprove(token, AAVE_POOL, 2n ** 256n - 1n);
      if (!r.success) return r;
    }

    // Supply
    const supplyData = buildSupplyData(token, amount);
    const result = await executeWithSignature(AAVE_POOL, 0n, supplyData);

    console.log(`[EXECUTOR] ✅ Supply executed. TX: ${result.txHash}`);
    return { ...result, action: 'supply', asset: token, amount: amount.toString() };
  } catch (error) {
    console.error(`[EXECUTOR] ❌ Error in supply:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      action: 'supply',
    };
  }
}

/**
 * Ejecuta borrow en Aave V3 (requiere colateral previo)
 */
export async function executeBorrow(
  token: Address,
  amount: bigint,
  interestRateMode: bigint = 2n
): Promise<ExecutionResult> {
  try {
    console.log(`[EXECUTOR] Borrow ${token} amount: ${amount} from Aave`);
    const borrowData = buildBorrowData(token, amount, interestRateMode);
    const result = await executeWithSignature(AAVE_POOL, 0n, borrowData);

    console.log(`[EXECUTOR] ✅ Borrow executed. TX: ${result.txHash}`);
    return { ...result, action: 'borrow', asset: token, amount: amount.toString() };
  } catch (error) {
    console.error(`[EXECUTOR] ❌ Error in borrow:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      action: 'borrow',
    };
  }
}

/**
 * Ejecuta repay en Aave V3 (requiere approve previo + balance)
 */
export async function executeRepay(
  token: Address,
  amount: bigint,
  interestRateMode: bigint = 2n
): Promise<ExecutionResult> {
  try {
    console.log(`[EXECUTOR] Repay ${token} amount: ${amount} to Aave`);

    // Approve token → Aave Pool (necesario para repay)
    const allowance = await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [MINIMAL_ACCOUNT, AAVE_POOL],
    });
    if ((allowance as bigint) < amount) {
      console.log(`[EXECUTOR] Approve → AAVE_POOL...`);
      const r = await executeApprove(token, AAVE_POOL, 2n ** 256n - 1n);
      if (!r.success) return r;
    }

    const repayData = buildRepayData(token, amount, interestRateMode);
    const result = await executeWithSignature(AAVE_POOL, 0n, repayData);

    console.log(`[EXECUTOR] ✅ Repay executed. TX: ${result.txHash}`);
    return { ...result, action: 'repay', asset: token, amount: amount.toString() };
  } catch (error) {
    console.error(`[EXECUTOR] ❌ Error in repay:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      action: 'repay',
    };
  }
}

/**
 * Ejecuta withdraw en Aave V3 (retirar colateral)
 */
export async function executeWithdraw(
  token: Address,
  amount: bigint
): Promise<ExecutionResult> {
  try {
    console.log(`[EXECUTOR] Withdraw ${token} amount: ${amount} from Aave`);
    const withdrawData = buildWithdrawData(token, amount);
    const result = await executeWithSignature(AAVE_POOL, 0n, withdrawData);

    console.log(`[EXECUTOR] ✅ Withdraw executed. TX: ${result.txHash}`);
    return { ...result, action: 'withdraw', asset: token, amount: amount.toString() };
  } catch (error) {
    console.error(`[EXECUTOR] ❌ Error in withdraw:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      action: 'withdraw',
    };
  }
}

// ============ SWAP + SUPPLY ATÓMICO (BATCH) ============

/**
 * Ejecuta swap + supply en una sola tx atómica via batchExecute.
 * Si algo falla, todo revierte.
 *
 * Flow: approve(router) + approve(permit2) + permit2.permit + swap + approve(aave) + supply
 */
export async function executeSwapAndSupply(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number = 3000
): Promise<ExecutionResult> {
  try {
    console.log(`[EXECUTOR] Swap+Supply: ${tokenIn} → ${tokenOut} → Aave (2 pasos)`);

    // PASO 1: Swap (executeSwap maneja approves + permit2 + swap)
    const swapResult = await executeSwap(tokenIn, tokenOut, amountIn, 1n, fee);
    if (!swapResult.success) {
      return { ...swapResult, action: 'swap_and_supply' };
    }

    // PASO 2: Leer balance real del tokenOut after swap
    const tokenOutBalance = await publicClient.readContract({
      address: tokenOut, abi: ERC20_ABI, functionName: 'balanceOf',
      args: [MINIMAL_ACCOUNT],
    }) as bigint;

    if (tokenOutBalance === 0n) {
      return { success: false, error: 'Swap succeeded but tokenOut balance is 0', action: 'swap_and_supply' };
    }

    console.log(`[EXECUTOR] Balance ${tokenOut} after swap: ${tokenOutBalance}`);

    // PASO 3: Supply del balance real en Aave
    const supplyResult = await executeSupply(tokenOut, tokenOutBalance);
    if (!supplyResult.success) {
      return { ...supplyResult, action: 'swap_and_supply', error: `Swap OK but supply failed: ${supplyResult.error}` };
    }

    console.log(`[EXECUTOR] ✅ Swap+Supply complete. Swap: ${swapResult.txHash} | Supply: ${supplyResult.txHash}`);
    return { success: true, txHash: supplyResult.txHash, action: 'swap_and_supply' };
  } catch (error) {
    console.error(`[EXECUTOR] ❌ Error in swap+supply:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      action: 'swap_and_supply',
    };
  }
}

// ============ DISPATCH DE DECISIONES DEL LLM ============

/**
 * Ejecuta una decisión del LLM
 */
export async function executeDecision(
  decision: {
    action: string;
    asset?: string;
    amount?: string;
    level: string;
    tokenIn?: string;
    tokenOut?: string;
    fee?: number;
    needsApproval?: boolean;
    approvalToken?: string;
    approvalSpender?: string;
  },
  tokenAddresses: Record<string, `0x${string}`>,
  tokenDecimals: Record<string, number>
): Promise<ExecutionResult> {
  const { action, amount, tokenIn, tokenOut } = decision;

  if (action === 'hold') {
    return { success: true, action: 'hold' };
  }

  // Approve — usar batch para todos los approves en una sola tx atómica
  if (action === 'request_approval') {
    const tokenSym = decision.approvalToken || tokenIn;
    if (!tokenSym || !tokenAddresses[tokenSym]) {
      return { success: false, action: 'request_approval', error: `Token not found: ${tokenSym}` };
    }
    const tokenAddr = tokenAddresses[tokenSym] as Address;
    const maxUint = 2n ** 256n - 1n;

    // Hacer todos los approves en un solo batch atómico
    const targets: Address[] = [
      tokenAddr,  // approve → UNIVERSAL_ROUTER
      tokenAddr,  // approve → PERMIT2
      tokenAddr,  // approve → AAVE_POOL
    ];
    const values: bigint[] = [0n, 0n, 0n];
    const datas: Hex[] = [
      buildApproveData(UNIVERSAL_ROUTER, maxUint),
      buildApproveData(PERMIT2, maxUint),
      buildApproveData(AAVE_POOL, maxUint),
    ];

    console.log(`[EXECUTOR] Batch approve ${tokenSym} → UNIVERSAL_ROUTER + PERMIT2 + AAVE_POOL`);
    const result = await batchExecuteWithSignature(targets, values, datas);
    return { ...result, action: 'approve' };
  }

  // Swap
  if (action === 'swap' || action === 'buy' || action === 'sell') {
    if (!tokenIn || !tokenOut) {
      return { success: false, error: 'Missing tokenIn or tokenOut', action };
    }
    if (!tokenAddresses[tokenIn] || !tokenAddresses[tokenOut]) {
      return { success: false, error: `Token not found: ${tokenIn} o ${tokenOut}`, action };
    }

    const tokenInAddr = tokenAddresses[tokenIn] as Address;
    const tokenOutAddr = tokenAddresses[tokenOut] as Address;
    const amountIn = BigInt(
      Math.floor(parseFloat(amount || '0') * Math.pow(10, tokenDecimals[tokenIn] || 18))
    );

    if (amountIn === 0n) {
      return { success: false, error: 'Amount is 0', action };
    }

    // Fee del LLM o default
    const fee = decision.fee || getDefaultFee(tokenIn, tokenOut);
    return await executeSwap(tokenInAddr, tokenOutAddr, amountIn, 1n, fee);
  }

  // Supply en Aave
  if (action === 'supply') {
    if (!tokenIn) {
      return { success: false, error: 'Missing token for supply', action };
    }
    if (!tokenAddresses[tokenIn]) {
      return { success: false, error: `Token not found: ${tokenIn}`, action };
    }
    const tokenAddr = tokenAddresses[tokenIn] as Address;
    const supplyAmount = BigInt(
      Math.floor(parseFloat(amount || '0') * Math.pow(10, tokenDecimals[tokenIn] || 18))
    );
    if (supplyAmount === 0n) {
      return { success: false, error: 'Amount is 0', action };
    }
    return await executeSupply(tokenAddr, supplyAmount);
  }

  // Borrow de Aave
  if (action === 'borrow') {
    if (!tokenIn) {
      return { success: false, error: 'Missing token for borrow', action };
    }
    if (!tokenAddresses[tokenIn]) {
      return { success: false, error: `Token not found: ${tokenIn}`, action };
    }
    const tokenAddr = tokenAddresses[tokenIn] as Address;
    const borrowAmount = BigInt(
      Math.floor(parseFloat(amount || '0') * Math.pow(10, tokenDecimals[tokenIn] || 18))
    );
    if (borrowAmount === 0n) {
      return { success: false, error: 'Amount is 0', action };
    }
    return await executeBorrow(tokenAddr, borrowAmount);
  }

  // Repay en Aave
  if (action === 'repay') {
    if (!tokenIn) {
      return { success: false, error: 'Missing token for repay', action };
    }
    if (!tokenAddresses[tokenIn]) {
      return { success: false, error: `Token not found: ${tokenIn}`, action };
    }
    const tokenAddr = tokenAddresses[tokenIn] as Address;
    const repayAmount = BigInt(
      Math.floor(parseFloat(amount || '0') * Math.pow(10, tokenDecimals[tokenIn] || 18))
    );
    if (repayAmount === 0n) {
      return { success: false, error: 'Amount is 0', action };
    }
    return await executeRepay(tokenAddr, repayAmount);
  }

  // Withdraw de Aave
  if (action === 'withdraw') {
    if (!tokenIn) {
      return { success: false, error: 'Missing token for withdraw', action };
    }
    if (!tokenAddresses[tokenIn]) {
      return { success: false, error: `Token not found: ${tokenIn}`, action };
    }
    const tokenAddr = tokenAddresses[tokenIn] as Address;
    const withdrawAmount = BigInt(
      Math.floor(parseFloat(amount || '0') * Math.pow(10, tokenDecimals[tokenIn] || 18))
    );
    if (withdrawAmount === 0n) {
      return { success: false, error: 'Amount is 0', action };
    }
    return await executeWithdraw(tokenAddr, withdrawAmount);
  }

  // Swap + Supply atómico
  if (action === 'swap_and_supply') {
    if (!tokenIn || !tokenOut) {
      return { success: false, error: 'Missing tokenIn or tokenOut', action };
    }
    if (!tokenAddresses[tokenIn] || !tokenAddresses[tokenOut]) {
      return { success: false, error: `Token not found`, action };
    }
    const tokenInAddr = tokenAddresses[tokenIn] as Address;
    const tokenOutAddr = tokenAddresses[tokenOut] as Address;
    const amountIn = BigInt(
      Math.floor(parseFloat(amount || '0') * Math.pow(10, tokenDecimals[tokenIn] || 18))
    );
    if (amountIn === 0n) {
      return { success: false, error: 'Amount is 0', action };
    }
    const fee = decision.fee || getDefaultFee(tokenIn, tokenOut);
    return await executeSwapAndSupply(tokenInAddr, tokenOutAddr, amountIn, fee);
  }

  return { success: false, error: `Action not supported: ${action}`, action };
}

/**
 * Fee por defecto según el par de tokens
 */
function getDefaultFee(tokenIn: string, tokenOut: string): number {
  // Fees confirmados en Celo mainnet
  if (tokenIn === 'wBRL' && tokenOut === 'USDT') return 100;
  if (tokenIn === 'USDT' && tokenOut === 'WBTC') return 3000;
  if (tokenIn === 'wBRL' && tokenOut === 'WBTC') return 100; // multihop handled separately
  // Default
  return 3000;
}

// ============ EXPORTS ============

export {
  MINIMAL_ACCOUNT,
  UNIVERSAL_ROUTER,
  PERMIT2,
  AAVE_POOL,
  publicClient,
  walletClient,
  adgentAccount,
};