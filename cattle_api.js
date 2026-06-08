import pino from 'pino';

const logger = pino({ name: 'cattle-api' });

/**
 * CattleAPI — HTTP client untuk Cattle Farm (cattlefarmonly.my.id)
 *
 * Bisa diinit dengan token langsung (skip auth) atau dengan initData.
 * Auto-reauth saat 401 kalau initData tersedia.
 */
export class CattleAPI {
  #baseUrl;
  #initData;
  #token = null;

  /**
   * @param {string} baseUrl    Base URL
   * @param {string} [initData] Telegram WebApp initData (opsional kalau token sudah ada)
   * @param {string} [token]    JWT token (langsung pakai, skip auth)
   */
  constructor(baseUrl, initData, token) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#initData = initData || null;
    this.#token = token || null;
    if (this.#token) {
      logger.info('Token loaded — skip auth');
    }
  }

  /** Ada token atau belum? */
  get hasToken() {
    return !!this.#token;
  }

  /** Ambil token (untuk simpan ke file) */
  get token() {
    return this.#token;
  }

  /** POST /api/auth/telegram — tukar initData → JWT */
  async authenticate(initData) {
    const dataToUse = initData || this.#initData;
    if (!dataToUse) {
      throw new Error('initData tidak tersedia. Tidak bisa re-auth.');
    }
    if (initData) this.#initData = initData;
    const res = await fetch(`${this.#baseUrl}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: dataToUse }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Auth failed (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    this.#token = data.token;
    logger.info(`Authenticated as user ${data.user?.id || '?'} (${data.user?.username || '?'})`);
    return data;
  }

  /** Internal request — Bearer header + auto-reauth kalau 401 + initData ada */
  async #request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.#token) headers['Authorization'] = `Bearer ${this.#token}`;

    let res = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // 401 + ada initData → coba re-auth sekali
    if (res.status === 401 && this.#initData) {
      logger.warn('Token expired — re-authenticating');
      await this.authenticate();
      headers['Authorization'] = `Bearer ${this.#token}`;
      res = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${method} ${path} failed (${res.status}): ${err.slice(0, 300)}`);
    }

    return res.json();
  }

  // ── Public API ──

  getFarmStatus()            { return this.#request('GET', '/api/farm/status'); }
  claimAnimal(type)          { return this.#request('POST', '/api/farm/claim', { animalType: type }); }
  upgradeAnimal(type)        { return this.#request('POST', '/api/farm/upgrade', { animalType: type }); }
  getUserMe()                { return this.#request('GET', '/api/user/me'); }
  claimDailyCoin()           { return this.#request('POST', '/api/tier/claim-daily-coin'); }
  claimAdReward()            { return this.#request('POST', '/api/user/claim-ad-reward'); }
  getConvertRates()          { return this.#request('GET', '/api/convert/rates'); }
  getPremiumInfo()           { return this.#request('GET', '/api/premium/info'); }
  getReferralInfo()          { return this.#request('GET', '/api/referral/info'); }
  getConvertHistory()        { return this.#request('GET', '/api/convert/history'); }

  /**
   * Convert produk ke USDT
   * Mencoba beberapa format body umum
   * @param {string} itemType  'cow' | 'goat' | 'duck' | 'chicken'
   * @param {number} amount    Jumlah produk
   */
  async convertProducts(itemType, amount) {
    // Mapping ke nama produk yang mungkin dipake API
    const productKey = `${itemType}Milk`;   // cowMilk, goatMilk
    const eggKey = `${itemType}Egg`;        // duckEgg, chickenEgg
    const isEgg = itemType === 'duck' || itemType === 'chicken';
    const productName = isEgg ? eggKey : productKey;

    const patterns = [
      { path: '/api/convert',        body: { itemType: productName, amount } },
      { path: '/api/convert',        body: { type: productName, amount } },
      { path: '/api/convert',        body: { itemType, amount } },
      { path: '/api/convert',        body: { type: itemType, amount } },
      { path: '/api/convert',        body: { itemType: productName, quantity: amount } },
    ];

    const errors = [];
    for (const p of patterns) {
      try {
        const res = await this.#request('POST', p.path, p.body);
        const earned = res.usdtEarned || res.amount || 0;
        logger.info(`✅ Convert ${productName} ×${amount} → ${earned} USDT`);
        return res;
      } catch (e) {
        errors.push(`${p.path} ${JSON.stringify(p.body)}: ${e.message.slice(0, 60)}`);
      }
    }
    // Log cuma 1 baris, bukan 15
    logger.info(`💡 Convert ${productName} gagal — coba manual: ${errors[0]}`);
    return null;
  }
}
