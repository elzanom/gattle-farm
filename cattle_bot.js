/**
 * Cattle Farm Autonomous Bot — Concurrent Mode
 *
 * DUA LOOP JALAN BERSAMAAN:
 *  - adsLoop()    : claim ad reward tiap 1 detik, jalan terus
 *  - harvestLoop(): claim harvest + upgrade + convert tiap 60 menit
 *
 * Mode:
 *   node cattle_bot.js                    → ads + harvest concurrent + Dashboard Server
 *   node cattle_bot.js --once             → 1x harvest cycle, exit
 *   node cattle_bot.js --dry-run          → baca status saja
 *   node cattle_bot.js --reauth [name]    → refresh token
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
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
const STATE_FILE = path.join(DIR, 'dashboard_state.json');
const CONFIG = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));

if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });

// ── Live State Tracking ──

const botState = {
  startedAt: new Date().toISOString(),
  accounts: {}
};

function initAccountState(name) {
  if (!botState.accounts[name]) {
    botState.accounts[name] = {
      name,
      status: 'idle', // 'idle' | 'authenticating' | 'active' | 'error'
      balances: { coin: 0, rupiah: 0, usdt: 0 },
      animals: {
        cow: { level: 0, balance: 0, nextClaimAt: null, isReady: false },
        goat: { level: 0, balance: 0, nextClaimAt: null, isReady: false },
        duck: { level: 0, balance: 0, nextClaimAt: null, isReady: false },
        chicken: { level: 0, balance: 0, nextClaimAt: null, isReady: false }
      },
      stats: {
        adsClaimed: 0,
        harvestsClaimed: 0,
        dailyCoinClaimed: 0,
        upgradesCount: 0,
        conversionsCount: 0,
        usdtEarned: 0
      },
      logs: [],
      lastActiveAt: null,
      error: null
    };
  }
}

function updateStateFromFarmStatus(name, status) {
  initAccountState(name);
  const acc = botState.accounts[name];
  if (status.coinBalance !== undefined) acc.balances.coin = status.coinBalance;
  if (status.rupiahBalance !== undefined) acc.balances.rupiah = status.rupiahBalance;

  if (status.levels) {
    for (const animal of ['cow', 'goat', 'duck', 'chicken']) {
      const lvlKey = `${animal}Level`;
      if (status.levels[lvlKey] !== undefined) {
        acc.animals[animal].level = status.levels[lvlKey];
      }
    }
  }

  if (status.balances) {
    for (const animal of ['cow', 'goat', 'duck', 'chicken']) {
      const balKey = animal === 'duck' || animal === 'chicken' ? `${animal}EggBalance` : `${animal}MilkBalance`;
      if (status.balances[balKey] !== undefined) {
        acc.animals[animal].balance = status.balances[balKey];
      }
    }
  }

  if (status.timers) {
    for (const t of status.timers) {
      const animal = t.animalType;
      if (acc.animals[animal]) {
        acc.animals[animal].isReady = t.isReady;
        acc.animals[animal].nextClaimAt = t.nextClaimAt;
      }
    }
  }
}

function logToAccount(name, message, level = 'info') {
  initAccountState(name);
  const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  botState.accounts[name].logs.unshift({ time, message, level });
  if (botState.accounts[name].logs.length > 50) {
    botState.accounts[name].logs.pop();
  }
  botState.accounts[name].lastActiveAt = new Date().toISOString();

  // Print ke console terminal juga
  if (level === 'error') {
    logger.error(`[${name}] ${message}`);
  } else if (level === 'warn') {
    logger.warn(`[${name}] ${message}`);
  } else {
    logger.info(`[${name}] ${message}`);
  }
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (data && data.accounts) {
        for (const name in data.accounts) {
          initAccountState(name);
          botState.accounts[name].stats = {
            ...botState.accounts[name].stats,
            ...data.accounts[name].stats
          };
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load dashboard_state.json, starting fresh stats.');
  }
}

function saveState() {
  try {
    const dataToSave = { accounts: {} };
    for (const name in botState.accounts) {
      dataToSave.accounts[name] = {
        stats: botState.accounts[name].stats
      };
    }
    writeFileSync(STATE_FILE, JSON.stringify(dataToSave, null, 2));
  } catch (err) {
    logger.error('Failed to save dashboard_state.json');
  }
}

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
  const { name } = account;
  initAccountState(name);
  botState.accounts[name].status = 'authenticating';
  
  const botUsername = CONFIG.botUsername || 'cattlefarmonly12_bot';
  const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';

  logToAccount(name, 'Auth via Telegram...');
  let tgClient;
  try {
    tgClient = await loginTelegram(account);
    logToAccount(name, `Ambil initData dari @${botUsername}...`);
    const initData = await getInitData(tgClient, botUsername, baseUrl);

    const api = new CattleAPI(baseUrl);
    const userData = await api.authenticate(initData);
    saveToken(name, api.token);
    
    // Update state
    botState.accounts[name].status = 'active';
    botState.accounts[name].error = null;
    if (userData.user) {
      botState.accounts[name].balances.usdt = userData.user.usdtBalance || 0;
    }
    
    logToAccount(name, `✅ JWT tersimpan (user ID: ${userData.user?.id || '?'})`);

    await tgClient.disconnect();
    return api;
  } catch (err) {
    botState.accounts[name].status = 'error';
    botState.accounts[name].error = err.message;
    logToAccount(name, `❌ Auth gagal: ${err.message}`, 'error');
    if (tgClient) {
      try { await tgClient.disconnect(); } catch {}
    }
    throw err;
  }
}

// ── Full cycle per account ──

async function processAccount(account) {
  const { name } = account;
  initAccountState(name);
  const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';
  const token = loadToken(name);

  if (!token) {
    logToAccount(name, 'Belum ada token — auth dulu...');
    const api = await authAccount(account);
    return await fullCycle(api, name);
  }

  const api = new CattleAPI(baseUrl, null, token);

  try {
    botState.accounts[name].status = 'active';
    const result = await fullCycle(api, name);
    saveToken(name, api.token);
    return result;
  } catch (err) {
    if (err.message.includes('401')) {
      logToAccount(name, 'Token expired — reauth...');
      const api2 = await authAccount(account);
      const result = await fullCycle(api2, name);
      saveToken(name, api2.token);
      return result;
    }
    botState.accounts[name].status = 'error';
    botState.accounts[name].error = err.message;
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
    logToAccount(accountName, `🪙 Daily coin: +${dc.coinClaimed} (balance: ${dc.newBalance})`);
    
    botState.accounts[accountName].balances.coin = dc.newBalance;
    botState.accounts[accountName].stats.dailyCoinClaimed += 1;
    saveState();
  } catch (e) {
    result.dailyCoin = { claimed: false, reason: e.message.slice(0, 100) };
    logToAccount(accountName, `🪙 Daily coin: ${e.message.slice(0, 80)}`);
  }

  // ── 2. ADS CLAIM (handled by separate adsLoop — skip disini) ──
  result.adReward = { claimed: false };

  // ── 3. GET FARM STATUS ──
  let status = await api.getFarmStatus();
  updateStateFromFarmStatus(accountName, status);
  const timers = status.timers || [];
  result.state = status;

  // ── 4. CLAIM HARVEST ──
  for (const t of timers) {
    const { animalType, isReady, nextClaimAt } = t;

    if (isReady) {
      try {
        const res = await api.claimAnimal(animalType);
        updateStateFromFarmStatus(accountName, res);
        
        const lvlKey = `${animalType}Level`;
        const eggKey = `${animalType}EggBalance`;
        const milkKey = `${animalType}MilkBalance`;
        result.harvest.claimed.push({
          animal: animalType,
          level: res.levels?.[lvlKey],
          product: res.balances?.[eggKey] ?? res.balances?.[milkKey] ?? 0,
        });
        
        botState.accounts[accountName].stats.harvestsClaimed += 1;
        saveState();
        
        status = res; // update status terbaru
        result.state = res;
      } catch (e) {
        logToAccount(accountName, `❌ Panen ${animalType} gagal: ${e.message.slice(0, 60)}`, 'error');
      }
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
      if (status.coinBalance < 200) break;

      try {
        const upg = await api.upgradeAnimal(animal);
        updateStateFromFarmStatus(accountName, upg);
        
        const newLevel = upg.levels?.[lvlKey] ?? currentLevel;
        result.upgrades.push({
          animal,
          fromLevel: currentLevel,
          toLevel: newLevel,
        });
        logToAccount(accountName, `⬆ ${animal} ↑ level ${currentLevel} → ${newLevel}`);
        
        botState.accounts[accountName].stats.upgradesCount += 1;
        saveState();
        
        // update coin balance untuk iterasi berikutnya
        levels[lvlKey] = newLevel;
        status = upg;
      } catch (e) {
        // Gagal upgrade (mungkin coin kurang) — lanjut animal berikutnya
        logToAccount(accountName, `⬆ ${animal} skip: ${e.message.slice(0, 60)}`);
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
      try {
        const conv = await api.convertProducts(p.itemType, amount);
        if (conv) {
          const earned = conv.usdtEarned || 0;
          result.convert = { itemType: p.itemType, amount, usdt: earned };
          
          // Dapatkan USDT balance terupdate
          const userMe = await api.getUserMe().catch(() => null);
          if (userMe) {
            botState.accounts[accountName].balances.usdt = userMe.usdtBalance || 0;
          }
          
          botState.accounts[accountName].stats.conversionsCount += 1;
          botState.accounts[accountName].stats.usdtEarned += earned;
          saveState();
          break; // stop setelah 1 sukses
        }
      } catch (e) {
        logToAccount(accountName, `💱 Convert ${p.itemType} gagal: ${e.message.slice(0, 60)}`, 'error');
      }
    }
  }

  return result;
}

// ── Print hasil ──

function printResult(result) {
  const name = result.accountName;

  // Daily coin
  if (result.dailyCoin?.claimed) {
    logToAccount(name, `🪙 Daily coin: +${result.dailyCoin.amount}`);
  }

  // Harvest
  for (const c of result.harvest.claimed) {
    logToAccount(name, `✓ ${c.animal.padEnd(8)} claimed (level ${c.level}, product ${c.product})`);
  }
  for (const s of result.harvest.skipped) {
    logToAccount(name, `○ ${s.animal.padEnd(8)} skipped (next: ${formatTime(s.nextClaimAt)})`);
  }

  // Upgrades
  for (const u of result.upgrades) {
    logToAccount(name, `⬆ ${u.animal.padEnd(8)} level ${u.fromLevel} → ${u.toLevel}`);
  }

  // Convert
  if (result.convert) {
    logToAccount(name, `💱 Converted ${result.convert.amount} ${result.convert.itemType} → ${result.convert.usdt} USDT`);
  }

  // Summary
  const s = result.state;
  logToAccount(name, `── Coin: ${s?.coinBalance || 0}  |  Rp ${s?.rupiahBalance || 0}`);
}

// ── Dry run ──

async function dryRunAccount(account) {
  const { name } = account;
  initAccountState(name);
  const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';
  const token = loadToken(name);

  if (!token) {
    logToAccount(name, '⚠ Tidak ada token — perlu login dulu', 'warn');
    return;
  }

  const api = new CattleAPI(baseUrl, null, token);
  try {
    const [status, rates, user] = await Promise.all([
      api.getFarmStatus(),
      api.getConvertRates().catch(() => null),
      api.getUserMe().catch(() => null),
    ]);

    updateStateFromFarmStatus(name, status);
    if (user) {
      botState.accounts[name].balances.usdt = user.usdtBalance || 0;
    }

    logToAccount(name, `═══════ FARM STATUS ═══════`);
    logToAccount(name, `Coin: ${status.coinBalance}  |  Rp ${status.rupiahBalance}  |  USDT: ${user?.usdtBalance || 0}`);
    logToAccount(name, `Tier: ${user?.tierName || '?'}  |  Daily coin: ${user?.lastDailyCoinClaimAt ? '✅ ' + formatTime(user.lastDailyCoinClaimAt) : '❌ Belum'}`);

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
      logToAccount(name, `  ${ready} ${a.padEnd(8)} Lv.${levels[lvlKey] ?? 0}  ${balance} produk  ${rateStr}  (${next})`);
    }
  } catch (err) {
    logToAccount(name, err.message, 'error');
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
      initAccountState(name);
      const token = loadToken(name);
      if (!token) continue;

      const api = new CattleAPI(baseUrl, null, token);
      try {
        const ar = await api.claimAdReward();
        saveToken(name, api.token);
        
        // Update state
        botState.accounts[name].balances.coin = ar.newBalance;
        botState.accounts[name].stats.adsClaimed += 1;
        saveState();
        
        logToAccount(name, `📺 Ad: +${ar.coinAwarded} (balance: ${ar.newBalance})`);
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
        logToAccount(acct.name, `═══════ Harvest Cycle ═══════`);
        const result = await processAccount(acct);
        printResult(result);
      } catch (err) {
        logToAccount(acct.name, `❌ ${err.message}`, 'error');
      }
    }

    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, interval - elapsed);
    logger.info(`Harvest cycle selesai dalam ${formatDuration(elapsed)}. Sleep ${formatDuration(remaining)}...`);
    await sleep(remaining);
  }
}

// ── Dashboard Web Server ──

function startDashboardServer(port = 3000) {
  const server = http.createServer((req, res) => {
    // Handle CORS preflight OPTIONS request
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }

    // API status
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      const snapshot = {
        startedAt: botState.startedAt,
        uptime: Date.now() - new Date(botState.startedAt).getTime(),
        accounts: botState.accounts
      };
      res.end(JSON.stringify(snapshot));
      return;
    }

    // POST /api/upgrade
    if (req.method === 'POST' && req.url === '/api/upgrade') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        
        try {
          const { accountName, animalType } = JSON.parse(body);
          if (!accountName || !animalType) {
            res.end(JSON.stringify({ error: 'Parameter accountName dan animalType harus diisi.' }));
            return;
          }

          logToAccount(accountName, `Aksi Manual: Upgrade ${animalType}...`);
          const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';
          const token = loadToken(accountName);
          if (!token) {
            res.end(JSON.stringify({ error: 'Token tidak ditemukan. Silakan jalankan bot terlebih dahulu.' }));
            return;
          }

          const api = new CattleAPI(baseUrl, null, token);
          let upg;
          try {
            upg = await api.upgradeAnimal(animalType);
          } catch (err) {
            if (err.message.includes('401')) {
              const account = CONFIG.accounts.find(a => a.name === accountName);
              if (account) {
                logToAccount(accountName, `Token expired, mencoba reauth untuk upgrade manual...`);
                const api2 = await authAccount(account);
                upg = await api2.upgradeAnimal(animalType);
              } else {
                throw err;
              }
            } else {
              throw err;
            }
          }

          updateStateFromFarmStatus(accountName, upg);
          botState.accounts[accountName].stats.upgradesCount += 1;
          saveState();
          logToAccount(accountName, `Manual upgrade ${animalType} sukses!`);
          res.end(JSON.stringify({ success: true, status: upg }));
        } catch (err) {
          logToAccount(req.url, `Gagal upgrade: ${err.message}`, 'error');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /api/convert
    if (req.method === 'POST' && req.url === '/api/convert') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });

        try {
          const { accountName, animalType, amount } = JSON.parse(body);
          if (!accountName || !animalType || amount === undefined) {
            res.end(JSON.stringify({ error: 'Parameter accountName, animalType, dan amount harus diisi.' }));
            return;
          }

          const qty = Number(amount);
          if (isNaN(qty) || qty <= 0) {
            res.end(JSON.stringify({ error: 'Jumlah konversi harus angka positif.' }));
            return;
          }

          logToAccount(accountName, `Aksi Manual: Konversi ${qty} produk ${animalType}...`);
          const baseUrl = CONFIG.baseUrl || 'https://www.cattlefarmonly.my.id';
          const token = loadToken(accountName);
          if (!token) {
            res.end(JSON.stringify({ error: 'Token tidak ditemukan. Silakan jalankan bot terlebih dahulu.' }));
            return;
          }

          const api = new CattleAPI(baseUrl, null, token);
          let conv;
          let activeApi = api;
          
          try {
            conv = await api.convertProducts(animalType, qty);
          } catch (err) {
            if (err.message.includes('401')) {
              const account = CONFIG.accounts.find(a => a.name === accountName);
              if (account) {
                logToAccount(accountName, `Token expired, mencoba reauth untuk convert manual...`);
                const api2 = await authAccount(account);
                activeApi = api2;
                conv = await api2.convertProducts(animalType, qty);
              } else {
                throw err;
              }
            } else {
              throw err;
            }
          }

          if (conv) {
            const earned = conv.usdtEarned || 0;
            
            // Segarkan status peternakan dan profil pengguna
            const [status, userMe] = await Promise.all([
              activeApi.getFarmStatus(),
              activeApi.getUserMe().catch(() => null)
            ]);
            
            updateStateFromFarmStatus(accountName, status);
            if (userMe) {
              botState.accounts[accountName].balances.usdt = userMe.usdtBalance || 0;
            }
            
            botState.accounts[accountName].stats.conversionsCount += 1;
            botState.accounts[accountName].stats.usdtEarned += earned;
            saveState();
            logToAccount(accountName, `Manual convert ${qty} ${animalType} sukses! (+${earned} USDT)`);
            res.end(JSON.stringify({ success: true, convertResult: conv }));
          } else {
            res.end(JSON.stringify({ error: 'Gagal melakukan konversi produk. Kemungkinan API salah.' }));
          }
        } catch (err) {
          logToAccount(req.url, `Gagal convert: ${err.message}`, 'error');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
    
    // Front-end Dashboard SPA
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html' || req.url === '/dashboard.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      try {
        const html = readFileSync(path.join(DIR, 'dashboard.html'), 'utf-8');
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error: dashboard.html file not found in bot directory.');
      }
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    logger.info(`Dashboard server running at http://localhost:${port}`);
  });
}

// ── Main ──

async function main() {
  const accounts = CONFIG.accounts || [];

  if (accounts.length === 0) {
    logger.error('Tidak ada account di config.json');
    process.exit(1);
  }

  logger.info(`Loaded ${accounts.length} account(s) from config.json`);

  // Initialize state
  for (const acct of accounts) {
    initAccountState(acct.name);
  }
  
  // Load persistent stats
  loadState();

  // Jalankan web server jika bukan dry-run / reauth
  if (!isDryRun && !reauthFlag) {
    const port = CONFIG.dashboardPort || 3000;
    startDashboardServer(port);
  }

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
        logToAccount(acct.name, `═══════ Harvest Cycle ═══════`);
        const result = await processAccount(acct);
        printResult(result);
      } catch (err) {
        logToAccount(acct.name, `❌ ${err.message}`, 'error');
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
