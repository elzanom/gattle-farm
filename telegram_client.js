/**
 * Telegram Client — GramJS (MTProto)
 * Multi-account: setiap account punya session file sendiri
 * Nomor telepon otomatis dari config, cuma OTP yang di-prompt
 */
import { TelegramClient } from 'telegram/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import pino from 'pino';

const logger = pino({ name: 'telegram-client' });
const DIR = path.dirname(fileURLToPath(import.meta.url));
const SESSION_BASE = path.join(DIR, 'sessions');

function sessionPath(accountName) {
  const dir = path.join(SESSION_BASE, accountName);
  return path.join(dir, 'gramjs.session');
}

function readSession(accountName) {
  try {
    const file = sessionPath(accountName);
    if (existsSync(file)) return readFileSync(file, 'utf-8').trim();
  } catch {}
  return '';
}

function writeSession(accountName, sessionString) {
  const file = sessionPath(accountName);
  if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, sessionString, 'utf-8');
  logger.info(`[${accountName}] Session saved`);
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
}

/**
 * Login ke Telegram untuk satu account
 * @param {object} account  { name, apiId, apiHash, phoneNumber }
 * @returns {TelegramClient}
 */
export async function loginTelegram(account) {
  const { name, apiId, apiHash, phoneNumber } = account;
  const storedSession = readSession(name);
  const stringSession = new StringSession(storedSession);

  const client = new TelegramClient(stringSession, Number(apiId), String(apiHash), {
    connectionRetries: 5,
    deviceModel: 'CattleBot',
    systemVersion: 'Linux',
    appVersion: '1.0.0',
  });

  let otpPrompted = false;
  const phone = phoneNumber || '';

  await client.start({
    phoneNumber: async () => phone,
    password: async () => await askQuestion(`[${name}] 🔑 Password (2FA jika ada): `),
    phoneCode: async () => {
      otpPrompted = true;
      return await askQuestion(`[${name}] 📨 Kode OTP dari Telegram: `);
    },
    onError: (err) => logger.error({ err: err.message }, `[${name}] Login error`),
  });

  if (!(await client.isUserAuthorized())) {
    throw new Error(`[${name}] Login gagal — tidak terauthorisasi`);
  }

  const saved = client.session.save();
  writeSession(name, saved);

  if (otpPrompted) logger.info(`[${name}] ✅ Login baru — session tersimpan`);
  else logger.info(`[${name}] ✅ Session valid — skip OTP`);

  return client;
}

/**
 * Dapatkan initData untuk Cattle Farm mini app
 * @param {TelegramClient} client
 * @param {string} botUsername
 * @param {string} [webAppUrl]
 * @returns {string} initData
 */
export async function getInitData(client, botUsername, webAppUrl) {
  const result = await client.invoke(
    new Api.messages.RequestWebView({
      peer: botUsername,
      bot: botUsername,
      platform: 'web',
      fromBotMenu: false,
      url: webAppUrl || '',
    })
  );

  logger.info({ fullUrl: result.url }, `[DEBUG] Raw URL from RequestWebView`);

  const fullUrl = result.url;
  if (!fullUrl) throw new Error('Tidak dapat URL webview dari bot');

  const urlObj = new URL(fullUrl);

  // Case 1: tgWebAppData sebagai query param
  const queryData = urlObj.searchParams.get('tgWebAppData');
  if (queryData) return decodeURIComponent(decodeURIComponent(queryData));

  // Case 2: tgWebAppData sebagai fragment/hash (#tgWebAppData=...&tgWebAppVersion=...)
  const hash = urlObj.hash || '';
  if (hash) {
    const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
    const hashData = hashParams.get('tgWebAppData');
    if (hashData) {
      const decoded = decodeURIComponent(hashData);
      logger.info({ initDataPreview: decoded.slice(0, 400) }, `[DEBUG] Extracted initData`);
      return decoded;
    }
  }

  // Case 3: query params langsung (fallback)
  const params = urlObj.searchParams.toString();
  if (params.includes('query_id=') || params.includes('hash=')) {
    return params;
  }

  throw new Error(`Tidak bisa extract initData dari: ${fullUrl.slice(0, 200)}`);
}
