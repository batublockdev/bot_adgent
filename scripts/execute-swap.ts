/**
 * execute-swap.ts
 * 
 * Ejecuta el flow completo del test MinimalAccountCeloTest.t.sol
 * directamente en Celo mainnet, sin LLM, sin loop.
 * 
 * Flow:
 * 1. execute(wBRL, 0, approve(UNIVERSAL_ROUTER, max))
 * 2. execute(wBRL, 0, approve(PERMIT2, max))
 * 3. execute(PERMIT2, 0, permit(wBRL, UNIVERSAL_ROUTER, max, max))
 * 4. execute(UNIVERSAL_ROUTER, 0, swap wBRL→WBTC)
 * 
 * Todo via UserOps firmadas por el agente y enviadas al EntryPoint.
 */

import { createPublicClient, createWalletClient, http, Address, Hex, parseAbi, encodeFunctionData, encodeAbiParameters, formatUnits } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import dotenv from 'dotenv';

dotenv.config();

// ============ CONFIG ============

const MINIMAL_ACCOUNT = '0x6BD2F54764f77357D9b748A65b29A01792f5Dd7d' as Address;
const ENTRY_POINT = '0x433709009B8330FDa32311DF1C2AFA402eD8D009' as Address;
const UNIVERSAL_ROUTER = '0xe2023F3FA515cF070e07fD9d51c1d236e07843f4' as Address;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
const wBRL = '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0' as Address;
const WBTC = '0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D' as Address;

const CELO_RPC = 'https://forno.celo.org';
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY as Hex;

const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT160 = 2n ** 160n - 1n;
const MAX_UINT48 = 2n ** 48n - 1n;

// ============ CLIENTS ============

const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC),
});

const agentAccount = privateKeyToAccount(AGENT_PRIVATE_KEY);

const walletClient = createWalletClient({
  account: agentAccount,
  chain: celo,
  transport: http(CELO_RPC),
});

// ============ ABIs ============

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
]);

const MINIMAL_ACCOUNT_ABI = parseAbi([
  'function execute(address target, uint256 value, bytes data) external',
  'function owner() view returns (address)',
  'function isAllowedTarget(address) view returns (bool)',
  'function isSelectorSupported(bytes4) view returns (bool)',
  'function isAllowedAddress(address) view returns (bool)',
]);

const ENTRY_POINT_ABI = [
  {
    type: 'function',
    name: 'handleOps',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'ops',
        type: 'tuple[]',
        components: [
          { name: 'sender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'accountGasLimits', type: 'bytes32' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'gasFees', type: 'bytes32' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'beneficiary', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getUserOpHash',
    stateMutability: 'view',
    inputs: [
      {
        name: 'userOp',
        type: 'tuple',
        components: [
          { name: 'sender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'accountGasLimits', type: 'bytes32' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'gasFees', type: 'bytes32' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getNonce',
    stateMutability: 'view',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key', type: 'uint192' },
    ],
    outputs: [{ name: 'nonce', type: 'uint256' }],
  },
] as const;

// ============ USER OP HELPERS ============

interface PackedUserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

function packUint128(hi: bigint, lo: bigint): Hex {
  const packed = (hi << 128n) | lo;
  return `0x${packed.toString(16).padStart(64, '0')}` as Hex;
}

async function getUserOpNonce(): Promise<bigint> {
  try {
    const nonce = await publicClient.readContract({
      address: ENTRY_POINT,
      abi: ENTRY_POINT_ABI,
      functionName: 'getNonce',
      args: [MINIMAL_ACCOUNT, 0n],
    });
    return nonce as bigint;
  } catch {
    return 0n;
  }
}

/**
 * Espera a que la tx se mine y el nonce de la wallet se actualice
 */
async function waitForTx(txHash: Hex): Promise<void> {
  console.log(`   ⏳ Esperando confirmación...`);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  // Pequeña pausa extra para que el nodo sincronice
  await new Promise(r => setTimeout(r, 2000));
}

function buildUnsignedUserOp(callData: Hex, nonce: bigint): PackedUserOp {
  const vgl = 16777216n; // ~16M
  const cgl = 30000000n; // 30M
  const maxPriority = 1000000000n; // 1 gwei priority
  const maxFee = 250000000000n; // 250 gwei (cubre base fee de Celo ~200 gwei)

  return {
    sender: MINIMAL_ACCOUNT,
    nonce,
    initCode: '0x' as Hex,
    callData,
    accountGasLimits: packUint128(vgl, cgl),
    preVerificationGas: vgl,
    gasFees: packUint128(maxPriority, maxFee),
    paymasterAndData: '0x' as Hex,
    signature: '0x' as Hex,
  };
}

async function signUserOp(userOp: PackedUserOp): Promise<PackedUserOp> {
  const userOpHash = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: 'getUserOpHash',
    args: [userOp as any],
  });

  const signature = await agentAccount.signMessage({
    message: { raw: userOpHash as Hex },
  });

  return { ...userOp, signature };
}

async function sendUserOp(userOp: PackedUserOp): Promise<Hex> {
  const txHash = await walletClient.writeContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: 'handleOps',
    args: [[userOp as any], agentAccount.address],
    gas: 5000000n,
  });
  return txHash;
}

// ============ CALLDATA BUILDERS ============

function buildExecuteCallData(target: Address, value: bigint, innerData: Hex): Hex {
  return encodeFunctionData({
    abi: MINIMAL_ACCOUNT_ABI,
    functionName: 'execute',
    args: [target, value, innerData],
  });
}

function buildApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

function buildPermit2Data(token: Address, spender: Address, amount: bigint, expiration: bigint): Hex {
  // permit(address,address,uint160,uint48)
  return encodeFunctionData({
    abi: parseAbi(['function permit(address token, address spender, uint160 amount, uint48 expiration)']),
    functionName: 'permit',
    args: [token, spender, amount as any, expiration as any],
  });
}

function buildSwapData(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  fee: number = 3000,
): Hex {
  // Command 0x00 = V3_SWAP_EXACT_IN
  const commands: Hex = '0x00' as Hex;

  // Path: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes)
  const path = `${tokenIn.slice(2)}${fee.toString(16).padStart(6, '0')}${tokenOut.slice(2)}`;

  const swapInput = encodeAbiParameters(
    [
      { type: 'address', name: 'recipient' },
      { type: 'uint256', name: 'amountIn' },
      { type: 'uint256', name: 'amountOutMin' },
      { type: 'bytes', name: 'path' },
      { type: 'bool', name: 'payerIsUser' },
      { type: 'bytes', name: 'extra' },
    ],
    [MINIMAL_ACCOUNT, amountIn, amountOutMin, `0x${path}` as Hex, true, '0x' as Hex],
  );

  const inputs: Hex[] = [swapInput];

  // execute(bytes commands, bytes[] inputs, uint256 deadline)
  const innerData = encodeAbiParameters(
    [
      { type: 'bytes', name: 'commands' },
      { type: 'bytes[]', name: 'inputs' },
      { type: 'uint256', name: 'deadline' },
    ],
    [commands, inputs, BigInt(Math.floor(Date.now() / 1000) + 600)],
  );

  return innerData as Hex;
}

// ============ MAIN ============

async function main() {
  console.log('🚀 Execute Swap Script — Celo mainnet');
  console.log(`📦 MinimalAccount: ${MINIMAL_ACCOUNT}`);
  console.log(`👤 Agent: ${agentAccount.address}`);
  console.log('');

  // 0. Verificar estado actual
  console.log('📊 Estado inicial:');
  const wBRLBalance = await publicClient.readContract({
    address: wBRL, abi: ERC20_ABI, functionName: 'balanceOf', args: [MINIMAL_ACCOUNT],
  });
  console.log(`   wBRL balance: ${formatUnits(wBRLBalance as bigint, 18)}`);

  const wbtcBalance = await publicClient.readContract({
    address: WBTC, abi: ERC20_ABI, functionName: 'balanceOf', args: [MINIMAL_ACCOUNT],
  });
  console.log(`   WBTC balance: ${formatUnits(wbtcBalance as bigint, 8)}`);

  // Verificar permisos
  const wbRLTarget = await publicClient.readContract({
    address: MINIMAL_ACCOUNT, abi: MINIMAL_ACCOUNT_ABI, functionName: 'isAllowedTarget', args: [wBRL],
  });
  console.log(`   wBRL target registrado: ${wbRLTarget ? '✅' : '❌'}`);

  const wbRLAllowed = await publicClient.readContract({
    address: MINIMAL_ACCOUNT, abi: MINIMAL_ACCOUNT_ABI, functionName: 'isAllowedAddress', args: [wBRL],
  });
  console.log(`   wBRL allowedAddress: ${wbRLAllowed ? '✅' : '❌'}`);

  if (!wbRLAllowed) {
    console.log('\n⚠️ wBRL NO está como allowedAddress. El approve va a fallar.');
    console.log('   Pero intentamos igual para ver el error exacto...');
  }

  // STEP 1: approve wBRL → UNIVERSAL_ROUTER
  console.log('\n--- STEP 1: approve wBRL → UNIVERSAL_ROUTER ---');
  const approveURData = buildApproveData(UNIVERSAL_ROUTER, MAX_UINT256);
  const callData1 = buildExecuteCallData(wBRL, 0n, approveURData);
  const nonce1 = await getUserOpNonce();
  let userOp1 = buildUnsignedUserOp(callData1, nonce1);
  userOp1 = await signUserOp(userOp1);
  
  try {
    const tx1 = await sendUserOp(userOp1);
    console.log(`✅ Step 1 TX: ${tx1}`);
    await waitForTx(tx1);
    // Verificar que el approve realmente se ejecutó
    const allowanceAfter = await publicClient.readContract({
      address: wBRL, abi: ERC20_ABI, functionName: 'allowance', args: [MINIMAL_ACCOUNT, UNIVERSAL_ROUTER],
    });
    console.log(`   Allowance wBRL → UR: ${(allowanceAfter as bigint) > 0n ? '✅ aprobado' : '❌ sigue en 0'}`);
    if ((allowanceAfter as bigint) === 0n) {
      console.log('   El approve revertió silenciosamente. Revisar permisos del MinimalAccount.');
      return;
    }
  } catch (e) {
    console.log(`❌ Step 1 failed: ${e instanceof Error ? e.message : String(e)}`);
    console.log('   Parando aquí. Faltan permisos.');
    return;
  }

  // STEP 2: approve wBRL → PERMIT2
  console.log('\n--- STEP 2: approve wBRL → PERMIT2 ---');
  const approveP2Data = buildApproveData(PERMIT2, MAX_UINT256);
  const callData2 = buildExecuteCallData(wBRL, 0n, approveP2Data);
  const nonce2 = await getUserOpNonce();
  let userOp2 = buildUnsignedUserOp(callData2, nonce2);
  userOp2 = await signUserOp(userOp2);

  try {
    const tx2 = await sendUserOp(userOp2);
    console.log(`✅ Step 2 TX: ${tx2}`);
    await waitForTx(tx2);
    const allowanceP2After = await publicClient.readContract({
      address: wBRL, abi: ERC20_ABI, functionName: 'allowance', args: [MINIMAL_ACCOUNT, PERMIT2],
    });
    console.log(`   Allowance wBRL → PERMIT2: ${(allowanceP2After as bigint) > 0n ? '✅ aprobado' : '❌ sigue en 0'}`);
  } catch (e) {
    console.log(`❌ Step 2 failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // STEP 3: permit2 permit(wBRL, UNIVERSAL_ROUTER, max, max)
  console.log('\n--- STEP 3: permit2 permit(wBRL → UNIVERSAL_ROUTER) ---');
  const permitData = buildPermit2Data(wBRL, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48);
  const callData3 = buildExecuteCallData(PERMIT2, 0n, permitData);
  const nonce3 = await getUserOpNonce();
  let userOp3 = buildUnsignedUserOp(callData3, nonce3);
  userOp3 = await signUserOp(userOp3);

  try {
    const tx3 = await sendUserOp(userOp3);
    console.log(`✅ Step 3 TX: ${tx3}`);
    await waitForTx(tx3);
  } catch (e) {
    console.log(`❌ Step 3 failed: ${e instanceof Error ? e.message : String(e)}`);
    console.log('   El permit puede no ser necesario para todos los swaps. Continuando...');
  }

  // STEP 4: swap wBRL → WBTC via Universal Router
  console.log('\n--- STEP 4: swap 3 wBRL → WBTC via Universal Router ---');
  const amountIn = wBRLBalance as bigint; // usar todo el balance
  const swapInnerData = buildSwapData(wBRL, WBTC, amountIn, 1n, 3000);
  const callData4 = buildExecuteCallData(UNIVERSAL_ROUTER, 0n, swapInnerData);
  const nonce4 = await getUserOpNonce();
  let userOp4 = buildUnsignedUserOp(callData4, nonce4);
  userOp4 = await signUserOp(userOp4);

  try {
    const tx4 = await sendUserOp(userOp4);
    console.log(`✅ Step 4 TX: ${tx4}`);
    
    // Verificar resultado
    const wbtcAfter = await publicClient.readContract({
      address: WBTC, abi: ERC20_ABI, functionName: 'balanceOf', args: [MINIMAL_ACCOUNT],
    });
    const wbrlAfter = await publicClient.readContract({
      address: wBRL, abi: ERC20_ABI, functionName: 'balanceOf', args: [MINIMAL_ACCOUNT],
    });
    console.log(`\n🎉 SWAP COMPLETO!`);
    console.log(`   wBRL después: ${formatUnits(wbrlAfter as bigint, 18)}`);
    console.log(`   WBTC después: ${formatUnits(wbtcAfter as bigint, 8)}`);
  } catch (e) {
    console.log(`❌ Step 4 failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch(console.error);