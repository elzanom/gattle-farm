/**
 * Cattle Farm Autonomous Bot — Concurrent Mode
 *
 * DUA LOOP JALAN BERSAMAAN:
 *  - adsLoop()    : claim ad reward tiap 1 detik, jalan terus
 *  - harvestLoop(): claim harvest + upgrade + convert tiap 60 menit
 *
 * Mode:
 *   node cattle_bot.js                    → ads + harvest concurrent
 *   node cattle_bot.js --once             → 1x harvest cycle, exit
 *   node cattle_bot.js --dry-run          → baca status saja
 *   node cattle_bot.js --reauth [name]    → refresh token
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import { CattleAPI } from './cattle_api.js';
import { loginTelegram, getInitData } from './telegram_client.js';

// ── Logger ──

const logger = pino({
  name: 'cattle-bot',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss' },
  },
});

// ── Paths ──

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(DIR, 'config.json');
const TOKEN_DIR = path.join(DIR, 'tokens');
const CONFIG = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));

if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });

// ── CLI ──

const args = process.argv.slice(2);
const isOnce = args.includes('--once');
const isDryRun = args.includes('--dry-run');
const reauthFlag = args.includes('--reauth');
const reauthTarget = args.find((a) => !a.startsWith('--')) || null;

// ── Token persistence ──

function tokenPath(accountName) {
  return path.join(TOKEN_DIR, `${accountName}.json`);
}

function loadToken(accountName) {
  try {
    const file = tokenPath(accountName);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8')).token;
  } catch {}
  return null;
}

function saveToken(accountName, token) {
  writeFileSync(
    tokenPath(accountName),
    JSON.stringify({ account: accountName, token, savedAt: new Date().toISOString() }, null, 2)
  );
}

// ── Helpers ──

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// ── Mapping animal → key di response rates ──
const RATE_KEYS = {
  cow:     { milk: 'cowMilkRate',     egg: null },
  goat:    { milk: 'goatMilkRate',    egg: null },
  duck:    { milk: null,              egg: 'duckEggRate' },
  chicken: { milk: null,              egg: 'chickenEggRate' },
};

/** Urutkan animal berdasarkan USDT rate tertinggi → terendah (dinamis dari API) */
function buildUpgradePriority(rates) {
  const defaultOrder = ['cow', 'goat', 'duck', 'chicken'];
  if (!rates || typeof rates !== 'object') return defaultOrder;

  return [...defaultOrder]
    .map((a) => {
      const keys = RATE_KEYS[a];
      const rate = rates[keys.milk] ?? rates[keys.egg] ?? 0;
      return { animal: a, rate };
    })
    .sort((a, b) => b.rate - a.rate)  // descending by rate
    .map((a) => a.animal);
}

// ── Auth ──

async function authAccount(account) {
  const { name, apiId, apiHash } = account;
  const botUsername = CONFIG.botUsername || 'cattlefarmonly12_bot';
  const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';

  logger.info(`[${name}] Auth via Telegram...`);
  const tgClient = await loginTelegram(account);
  logger.info(`[${name}] Ambil initData dari @${botUsername}...`);
  const initData = await getInitData(tgClient, botUsername, baseUrl);

  const api = new CattleAPI(baseUrl);
  const userData = await api.authenticate(initData);
  saveToken(name, api.token);
  logger.info(`[${name}] ✅ JWT tersimpan (user ID: ${userData.user?.id})`);

  await tgClient.disconnect();
  return api;
}

// ── Full cycle per account ──

async function processAccount(account) {
  const { name } = account;
  const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';
  const token = loadToken(name);

  if (!token) {
    logger.info(`[${name}] Belum ada token — auth dulu...`);
    const api = await authAccount(account);
    return await fullCycle(api, name);
  }

  const api = new CattleAPI(baseUrl, null, token);

  try {
    const result = await fullCycle(api, name);
    saveToken(name, api.token);
    return result;
  } catch (err) {
    if (err.message.includes('401')) {
      logger.info(`[${name}] Token expired — reauth...`);
      const api2 = await authAccount(account);
      const result = await fullCycle(api2, name);
      saveToken(name, api2.token);
      return result;
    }
    throw err;
  }
}

/**
 * Full cycle: claim → upgrade → convert
 */
async function fullCycle(api, accountName) {
  const result = {
    accountName,
    harvest: { claimed: [], skipped: [] },
    dailyCoin: null,
    adReward: null,
    upgrades: [],
    convert: null,
    state: null,
  };

  // ── 1. CLAIM DAILY COIN ──
  try {
    const dc = await api.claimDailyCoin();
    result.dailyCoin = { claimed: true, amount: dc.coinClaimed, balance: dc.newBalance };
    logger.info(`[${accountName}] 🪙 Daily coin: +${dc.coinClaimed} (balance: ${dc.newBalance})`);
  } catch (e) {
    result.dailyCoin = { claimed: false, reason: e.message.slice(0, 100) };
    logger.info(`[${accountName}] 🪙 Daily coin: ${e.message.slice(0, 80)}`);
  }

  // ── 2. ADS CLAIM (handled by separate adsLoop — skip disini) ──
  result.adReward = { claimed: false };

  // ── 3. GET FARM STATUS ──
  let status = await api.getFarmStatus();
  const timers = status.timers || [];
  result.state = status;

  // ── 4. CLAIM HARVEST ──
  for (const t of timers) {
    const { animalType, isReady, nextClaimAt } = t;

    if (isReady) {
      const res = await api.claimAnimal(animalType);
      const lvlKey = `${animalType}Level`;
      const eggKey = `${animalType}EggBalance`;
      const milkKey = `${animalType}MilkBalance`;
      result.harvest.claimed.push({
        animal: animalType,
        level: res.levels?.[lvlKey],
        product: res.balances?.[eggKey] ?? res.balances?.[milkKey] ?? 0,
      });
      status = res; // update status terbaru
      result.state = res;
    } else {
      result.harvest.skipped.push({ animal: animalType, nextClaimAt });
    }
  }

  // ── 5. UPGRADE ANIMALS (prioritas: rate USDT tertinggi) ──
  const coinBalance = status.coinBalance || 0;
  // Fetch rates duluan supaya bisa sorting priority
  const rates = await api.getConvertRates().catch(() => ({}));
  const upgradeOrder = buildUpgradePriority(rates);

  if (coinBalance > 500) {
    const levels = status.levels || {};

    for (const animal of upgradeOrder) {
      // Hanya upgrade cow & goat — skip chicken & duck
      if (animal !== 'cow' && animal !== 'goat') continue;
      const lvlKey = `${animal}Level`;
      const currentLevel = levels[lvlKey] ?? 0;

      // Batasi upgrade: jangan upgrade kalo total coin nanti < 200 (sisakan buffer)
      if (coinBalance < 200) break;

      try {
        const upg = await api.upgradeAnimal(animal);
        const newLevel = upg.levels?.[lvlKey] ?? currentLevel;
        result.upgrades.push({
          animal,
          fromLevel: currentLevel,
          toLevel: newLevel,
        });
        logger.info(`[${accountName}] ⬆ ${animal} ↑ level ${currentLevel} → ${newLevel}`);
        // update coin balance untuk iterasi berikutnya
        levels[lvlKey] = newLevel;
      } catch (e) {
        // Gagal upgrade (mungkin coin kurang) — lanjut animal berikutnya
        logger.info(`[${accountName}] ⬆ ${animal} skip: ${e.message.slice(0, 60)}`);
      }
    }
  }

  // ── 6. CONVERT PRODUK KE USDT (jika balance cukup) ──
  // Coba 1 produk teratas yang punya balance, stop kalau berhasil
  const balances = status.balances || {};

  const productPriority = [
    { itemType: 'cow',     key: 'cowMilkBalance',     rate: rates.cowMilkRate },
    { itemType: 'goat',    key: 'goatMilkBalance',    rate: rates.goatMilkRate },
    { itemType: 'duck',    key: 'duckEggBalance',     rate: rates.duckEggRate },
    { itemType: 'chicken', key: 'chickenEggBalance',  rate: rates.chickenEggRate },
  ];

  // Cari produk dengan balance > 0, mulai dari yang paling bernilai
  for (const p of productPriority) {
    const amount = balances[p.key] || 0;
    if (amount > 0) {
      const conv = await api.convertProducts(p.itemType, amount);
      if (conv) {
        result.convert = { itemType: p.itemType, amount, usdt: conv.usdtEarned || 0 };
        break; // stop setelah 1 sukses
      }
      // Kalau gagal, coba produk berikutnya
    }
  }

  return result;
}

// ── Print hasil ──

function printResult(result) {
  const name = result.accountName;

  // Daily coin
  if (result.dailyCoin?.claimed) {
    logger.info(`[${name}] 🪙 Daily coin: +${result.dailyCoin.amount}`);
  }

  // Harvest
  for (const c of result.harvest.claimed) {
    logger.info(`[${name}]   ✓ ${c.animal.padEnd(8)} claimed (level ${c.level}, product ${c.product})`);
  }
  for (const s of result.harvest.skipped) {
    logger.info(`[${name}]   ○ ${s.animal.padEnd(8)} skipped (next: ${formatTime(s.nextClaimAt)})`);
  }

  // Upgrades
  for (const u of result.upgrades) {
    logger.info(`[${name}]   ⬆ ${u.animal.padEnd(8)} level ${u.fromLevel} → ${u.toLevel}`);
  }

  // Convert
  if (result.convert) {
    logger.info(`[${name}]   💱 Converted ${result.convert.amount} ${result.convert.itemType} → ${result.convert.usdt} USDT`);
  }

  // Summary
  const s = result.state;
  logger.info(`[${name}]   ── Coin: ${s?.coinBalance || 0}  |  Rp ${s?.rupiahBalance || 0}`);
}

// ── Dry run ──

async function dryRunAccount(account) {
  const { name } = account;
  const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';
  const token = loadToken(name);

  if (!token) {
    logger.info(`[${name}] ⚠ Tidak ada token — perlu login dulu`);
    return;
  }

  const api = new CattleAPI(baseUrl, null, token);
  try {
    const [status, rates, user] = await Promise.all([
      api.getFarmStatus(),
      api.getConvertRates().catch(() => null),
      api.getUserMe().catch(() => null),
    ]);

    logger.info(`[${name}] ═══════ FARM STATUS ═══════`);
    logger.info(`[${name}] Coin: ${status.coinBalance}  |  Rp ${status.rupiahBalance}  |  USDT: ${user?.usdtBalance || 0}`);
    logger.info(`[${name}] Tier: ${user?.tierName || '?'}  |  Daily coin: ${user?.lastDailyCoinClaimAt ? '✅ ' + formatTime(user.lastDailyCoinClaimAt) : '❌ Belum'}`);

    const levels = status.levels || {};
    const farmRates = rates || {};
    const displayOrder = buildUpgradePriority(farmRates);
    for (const a of displayOrder) {
      const lvlKey = `${a}Level`;
      const eggKey = `${a}EggBalance`;
      const milkKey = `${a}MilkBalance`;
      const balKey = eggKey in status.balances ? eggKey : milkKey;
      const balance = status.balances?.[balKey] || 0;
      const rate = rates?.[`${a}EggRate`] || rates?.[`${a}MilkRate`] || 0;
      const timer = (status.timers || []).find((t) => t.animalType === a);
      const ready = timer?.isReady ? '●' : '○';
      const next = timer?.isReady ? 'READY' : `next ${formatTime(timer?.nextClaimAt)}`;
      const rateStr = rate ? `${(rate * 1000).toFixed(2)}m USDT` : '?';
      logger.info(`[${name}]   ${ready} ${a.padEnd(8)} Lv.${levels[lvlKey] ?? 0}  ${balance} produk  ${rateStr}  (${next})`);
    }
  } catch (err) {
    logger.error(`[${name}] ${err.message}`);
  }
}

// ── ADS LOOP (jalan terus, claim ad tiap 1 detik per account) ──

async function adsLoop() {
  const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';
  const accounts = CONFIG.accounts || [];

  while (true) {
    let anySuccess = false;

    for (const account of accounts) {
      const { name } = account;
      const token = loadToken(name);
      if (!token) continue;

      const api = new CattleAPI(baseUrl, null, token);
      try {
        const ar = await api.claimAdReward();
        saveToken(name, api.token);
        logger.info(`[${name}] 📺 Ad: +${ar.coinAwarded} (balance: ${ar.newBalance})`);
        anySuccess = true;
        await sleep(1000);
      } catch (e) {
        if (e.message.includes('401')) {
          // Token expired — diam, harvest loop yg handle reauth
          continue;
        }
        // Daily cap — coba account berikutnya
        await sleep(1000);
      }
    }

    // Kalo semua account habis ads-nya, tunggu 30 detik
    if (!anySuccess) {
      await sleep(30000);
    }
  }
}

// ── HARVEST LOOP (tiap 60 menit) ──

async function harvestLoop() {
  const accounts = CONFIG.accounts || [];
  const interval = (CONFIG.intervalMinutes || 60) * 60 * 1000;

  while (true) {
    const cycleStart = Date.now();

    for (const acct of accounts) {
      try {
        logger.info(`[${acct.name}] ═══════ Harvest Cycle ═══════`);
        const result = await processAccount(acct);
        printResult(result);
      } catch (err) {
        logger.error(`[${acct.name}] ❌ ${err.message}`);
      }
    }

    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, interval - elapsed);
    logger.info(`Harvest cycle selesai dalam ${formatDuration(elapsed)}. Sleep ${formatDuration(remaining)}...`);
    await sleep(remaining);
  }
}

// ── Main ──

async function main() {
  const accounts = CONFIG.accounts || [];

  if (accounts.length === 0) {
    logger.error('Tidak ada account di config.json');
    process.exit(1);
  }

  logger.info(`Loaded ${accounts.length} account(s) from config.json`);

  // ── DRY RUN ──
  if (isDryRun) {
    logger.info('═══════ DRY RUN ═══════');
    for (const acct of accounts) {
      await dryRunAccount(acct);
    }
    process.exit(0);
  }

  // ── REAUTH ──
  if (reauthFlag) {
    const targets = reauthTarget
      ? accounts.filter((a) => a.name === reauthTarget)
      : accounts;
    if (targets.length === 0) {
      logger.error(`Account "${reauthTarget}" tidak ditemukan`);
      process.exit(1);
    }
    for (const acct of targets) {
      logger.info(`[${acct.name}] Reauth...`);
      await authAccount(acct);
    }
    logger.info('Reauth selesai.');
    process.exit(0);
  }

  // ── ONCE ──
  if (isOnce) {
    logger.info('Mode: ONCE');
    for (const acct of accounts) {
      try {
        logger.info(`[${acct.name}] ═══════ Harvest Cycle ═══════`);
        const result = await processAccount(acct);
        printResult(result);
      } catch (err) {
        logger.error(`[${acct.name}] ❌ ${err.message}`);
      }
    }
    logger.info('Selesai ✓');
    process.exit(0);
  }

  // ── CONCURRENT (default) — ads loop + harvest loop ──
  logger.info(`Mode: CONCURRENT — ads (1s) + harvest (${CONFIG.intervalMinutes || 60}m)`);
  await Promise.all([
    adsLoop(),
    harvestLoop(),
  ]);
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Fatal');
  process.exit(1);
});
