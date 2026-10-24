import { createWalletClient, http, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { withAttribution } from '@celo/attribution-tags';
import dotenv from 'dotenv';

dotenv.config(); // Cargar variables de entorno

const AGENT_PRIVATE_KEY: Hex = (process.env.AGENT_PRIVATE_KEY as Hex) || '0x0000000000000000000000000000000000000000000000000000000000000000'; // Usa una clave vacía si no está definida para evitar errores, pero DEBE ser una clave real
export const ATTRIBUTION_TAG = process.env.ATTRIBUTION_TAG || 'celo_6d966470558a'; // Tu attribution tag oficial

// Account para el agent
export const agentAccount = privateKeyToAccount(AGENT_PRIVATE_KEY);

// Cliente Viem con atribución para Celo mainnet
export const walletClient = createWalletClient({
  account: agentAccount,
  chain: celo,
  transport: http('https://forno.celo.org'), // RPC de Celo mainnet
}).extend(withAttribution(ATTRIBUTION_TAG));

console.log(`Agent Wallet Address: ${agentAccount.address}`);
console.log(`Attribution Tag: ${ATTRIBUTION_TAG}`);
