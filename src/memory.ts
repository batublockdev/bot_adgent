/**
 * @title memory.ts
 * @notice Memoria del agent migrada a PostgreSQL (pg) para deploy en Railway.
 * Reemplaza better-sqlite3 que no funciona en serverless/containers ligeros.
 */

import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ============ CONEXIÓN POSTGRES ============

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway inyecta DATABASE_URL automáticamente
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
  max: 5, // pool pequeño — el agent es single-process
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

let initialized = false;

/**
 * Crea las tablas si no existen. Idempotente.
 */
export async function initDB(): Promise<void> {
  if (initialized) return;
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] ⚠️ DATABASE_URL no configurada. Operando sin base de datos (modo local/no-op).');
    initialized = true;
    return;
  }
  initialized = true;

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_category_key_idx ON knowledge(category, key);

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        action TEXT NOT NULL,
        asset TEXT,
        amount TEXT,
        price TEXT,
        pnl TEXT,
        tx_hash TEXT,
        level TEXT NOT NULL,
        reason TEXT,
        confidence INTEGER
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        action TEXT NOT NULL,
        asset TEXT,
        amount TEXT,
        reason TEXT,
        confidence INTEGER,
        level TEXT NOT NULL,
        executed INTEGER DEFAULT 0,
        result TEXT
      );

      CREATE TABLE IF NOT EXISTS performance (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        total_value TEXT,
        total_pnl TEXT,
        win_rate TEXT,
        trade_count INTEGER
      );

      CREATE TABLE IF NOT EXISTS strategies (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used BIGINT,
        notes TEXT
      );
    `);
    console.log('[DB] Tablas verificadas/creadas en PostgreSQL');
  } finally {
    client.release();
  }
}

/**
 * Wrapper para queries que asegura initDB() se ejecutó primero.
 */
async function query(text: string, params?: any[]) {
  if (!process.env.DATABASE_URL) {
    return { rows: [] };
  }
  if (!initialized) await initDB();
  return pool.query(text, params);
}

// ============ TRADES ============

export function saveTrade(trade: {
  action: string;
  asset?: string;
  amount?: string;
  price?: string;
  pnl?: string;
  tx_hash?: string;
  level: string;
  reason?: string;
  confidence?: number;
}): Promise<void> {
  return query(
    `INSERT INTO trades (timestamp, action, asset, amount, price, pnl, tx_hash, level, reason, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      Date.now(),
      trade.action,
      trade.asset || null,
      trade.amount || null,
      trade.price || null,
      trade.pnl || null,
      trade.tx_hash || null,
      trade.level,
      trade.reason || null,
      trade.confidence || null,
    ]
  ).then(() => {});
}

export async function getRecentTrades(limit: number = 10): Promise<any[]> {
  const res = await query('SELECT * FROM trades ORDER BY timestamp DESC LIMIT $1', [limit]);
  return res.rows;
}

export async function getAllTrades(): Promise<any[]> {
  const res = await query('SELECT * FROM trades ORDER BY timestamp ASC');
  return res.rows;
}

// ============ DECISIONES ============

export function saveDecision(decision: {
  action: string;
  asset?: string;
  amount?: string;
  reason: string;
  confidence: number;
  level: string;
}): Promise<void> {
  return query(
    `INSERT INTO decisions (timestamp, action, asset, amount, reason, confidence, level)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      Date.now(),
      decision.action,
      decision.asset || null,
      decision.amount || null,
      decision.reason,
      decision.confidence,
      decision.level,
    ]
  ).then(() => {});
}

export async function updateDecisionResult(id: number, executed: boolean, result: string): Promise<void> {
  await query('UPDATE decisions SET executed = $1, result = $2 WHERE id = $3', [
    executed ? 1 : 0,
    result,
    id,
  ]);
}

// ============ PERFORMANCE ============

export function savePerformance(snapshot: {
  total_value: string;
  total_pnl: string;
  win_rate: string;
  trade_count: number;
}): Promise<void> {
  return query(
    `INSERT INTO performance (timestamp, total_value, total_pnl, win_rate, trade_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [Date.now(), snapshot.total_value, snapshot.total_pnl, snapshot.win_rate, snapshot.trade_count]
  ).then(() => {});
}

export async function getLatestPerformance(): Promise<any | null> {
  const res = await query('SELECT * FROM performance ORDER BY timestamp DESC LIMIT 1');
  return res.rows[0] || null;
}

// ============ ESTRATEGIAS ============

export async function saveStrategy(name: string, description: string, notes?: string): Promise<void> {
  await query(
    `INSERT INTO strategies (name, description, notes, last_used)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, notes = EXCLUDED.notes`,
    [name, description, notes || null, Date.now()]
  );
}

export async function updateStrategyResult(name: string, success: boolean): Promise<void> {
  if (success) {
    await query('UPDATE strategies SET success_count = success_count + 1, last_used = $1 WHERE name = $2', [Date.now(), name]);
  } else {
    await query('UPDATE strategies SET fail_count = fail_count + 1, last_used = $1 WHERE name = $2', [Date.now(), name]);
  }
}

export async function getStrategies(): Promise<any[]> {
  const res = await query('SELECT * FROM strategies ORDER BY (success_count + fail_count) DESC');
  return res.rows;
}

// ============ KNOWLEDGE BASE ============

export async function upsertKnowledge(category: string, key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO knowledge (category, key, value, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, created_at = EXCLUDED.created_at`,
    [category, key, value, Date.now()]
  );
}

export async function deleteKnowledge(category: string, key: string): Promise<void> {
  await query('DELETE FROM knowledge WHERE category = $1 AND key = $2', [category, key]);
}

export async function cleanMarketKnowledge(): Promise<void> {
  await query("DELETE FROM knowledge WHERE category = 'market'");
}

export async function getKnowledgeBase(): Promise<string> {
  const res = await query('SELECT category, key, value FROM knowledge ORDER BY category, key');
  const rows = res.rows;
  if (rows.length === 0) return '';

  const byCategory: Record<string, string[]> = {};
  for (const r of rows) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(`  ${r.key}: ${r.value}`);
  }

  let out = '════════════════════════════════════════\n';
  out += 'BASE DE CONOCIMIENTO DEL AGENTE\n';
  out += '════════════════════════════════════════\n';

  const labels: Record<string, string> = {
    token: 'TOKENS EN CELO',
    uniswap: 'UNISWAP V3',
    aave: 'AAVE V3',
    strategy: 'ESTRATEGIAS DE INVERSIÓN',
    rule: 'REGLAS CRÍTICAS',
    market: 'DATOS DE MERCADO',
  };

  for (const [cat, items] of Object.entries(byCategory)) {
    out += `\n${labels[cat] || cat.toUpperCase()}:\n`;
    out += items.join('\n') + '\n';
  }

  return out;
}

// ============ RESUMEN PARA CONTEXTO ============

export async function getMemorySummary(): Promise<string> {
  const knowledge = await getKnowledgeBase();

  let summary = '';

  if (knowledge) {
    summary += knowledge + '\n';
  }

  const recentTrades = await getRecentTrades(5);
  if (recentTrades.length > 0) {
    summary += `Últimos ${recentTrades.length} trades:\n`;
    for (const t of recentTrades) {
      const date = new Date(t.timestamp).toLocaleString('es-CO');
      summary += `  - [${date}] ${t.action.toUpperCase()} ${t.amount || ''} ${t.asset || ''} | ${t.reason || ''}\n`;
    }
  } else {
    summary += 'Sin trades previos.\n';
  }

  const perf = await getLatestPerformance();
  if (perf) {
    summary += `\nPerformance:\n`;
    summary += `  - Valor total: ${perf.total_value} USD\n`;
    summary += `  - P&L acumulado: ${perf.total_pnl}\n`;
    summary += `  - Win rate: ${perf.win_rate}%\n`;
    summary += `  - Trades totales: ${perf.trade_count}\n`;
  }

  const strategies = await getStrategies();
  if (strategies.length > 0) {
    summary += `\nEstrategias conocidas:\n`;
    for (const s of strategies) {
      const total = s.success_count + s.fail_count;
      const rate = total > 0 ? Math.round((s.success_count / total) * 100) : 0;
      summary += `  - ${s.name}: ${rate}% éxito — ${s.description}\n`;
    }
  }

  return summary;
}

// ============ CLEANUP ============

export async function closeDB(): Promise<void> {
  if (process.env.DATABASE_URL) {
    await pool.end();
  }
}

export default pool;