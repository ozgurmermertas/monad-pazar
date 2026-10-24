// Pazar sunucusu
//  - public/ klasöründeki web arayüzünü sunar
//  - /api/config     → sözleşme adresi ve ABI
//  - /api/drip       → demo cüzdanına başlangıç MON'u gönderir (operatör cüzdanından)
//  - /api/ai/order   → Türkçe cümleyi emre çevirir (Claude; .env içinde ANTHROPIC_API_KEY varsa)
//
// Çalıştır: node server.mjs   (varsayılan port 3000)

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { formatEther, isAddress, parseEther } from 'viem';
import { c, EXPLORER, loadEnv, operatorAccount, publicClient, readDeployment, ROOT, walletFor } from './lib/chain.mjs';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(ROOT, 'public');
const env = loadEnv();
const DRIP = parseEther(env.DRIP_MON || '0.2');
// Herkese açık sunucuda operatör cüzdanı boşalmasın: saatlik toplam sınır
const DRIP_MAX_PER_HOUR = Number(env.DRIP_MAX_PER_HOUR || 6);
const dripLog = []; // zaman damgaları
// Yapay zeka: IP başına ve toplam sınır (API kredisi korunur)
const AI_PER_IP = Number(env.AI_PER_IP_10MIN || 12);
const AI_MAX_PER_HOUR = Number(env.AI_MAX_PER_HOUR || 120);
const aiLog = []; // { ip, t }
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (ch) => {
      data += ch;
      if (data.length > limit) {
        reject(new Error('İstek çok büyük'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ───────────────────────── Damlatıcı ─────────────────────────
const dripped = new Map(); // adres → zaman
let dripQueue = Promise.resolve(); // operatör işlemleri sırayla (nonce çakışmasın)

async function drip(address) {
  const key = address.toLowerCase();
  const last = dripped.get(key);
  if (last && Date.now() - last < 60 * 60 * 1000) return { skipped: true, reason: 'Bu cüzdana son bir saatte zaten gönderildi.' };
  const bal = await publicClient.getBalance({ address });
  if (bal >= DRIP / 2n) return { skipped: true, reason: 'Cüzdanda zaten yeterli MON var.' };
  const hourAgo = Date.now() - 60 * 60 * 1000;
  while (dripLog.length && dripLog[0] < hourAgo) dripLog.shift();
  if (dripLog.length >= DRIP_MAX_PER_HOUR) {
    const e = new Error(`Demo musluğu bu saat için doldu. ${address} adresine https://faucet.monad.xyz üzerinden test MON alabilirsin.`);
    e.status = 429;
    throw e;
  }
  dripLog.push(Date.now());
  const run = async () => {
    const t = Date.now();
    // Monad "reserve balance": operatör 10 MON'un altındayken son ~3 blokta başka işlemi
    // varsa değer transferi geri çevrilir. Geri çevrilirse biraz bekleyip yeniden dene.
    let hash;
    const m = readDeployment()?.musluk;
    for (let attempt = 1; ; attempt++) {
      hash = m
        ? // Musluk sözleşmesinden gönder: operatör yalnızca gas öder, reserve balance kuralına takılmaz
          await walletFor(operatorAccount()).writeContract({ address: m.address, abi: m.abi, functionName: 'drip', args: [address, DRIP] })
        : await walletFor(operatorAccount()).sendTransaction({ to: address, value: DRIP });
      const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
      if (r.status === 'success') break;
      console.log(c.yellow(`! Damla geri çevrildi (deneme ${attempt}), bekleniyor`));
      if (attempt >= 4) throw new Error(`MON gönderimi geri çevrildi: ${EXPLORER}/tx/${hash}`);
      await new Promise((x) => setTimeout(x, 2500 * attempt));
    }
    dripped.set(key, Date.now());
    console.log(c.green('✓ Damla'), c.dim(`${formatEther(DRIP)} MON → ${address} (${Date.now() - t} ms)`));
    return { hash, ms: Date.now() - t, amount: formatEther(DRIP) };
  };
  const p = dripQueue.then(run, run);
  // Monad "reserve balance": operatörün art arda değer transferleri arasında ~2 sn bırak
  dripQueue = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 2000)));
  return p;
}

// ───────────────────────── Yapay zeka: Türkçe emir ─────────────────────────
const ORDER_TOOL = {
  name: 'create_order',
  description: 'Kullanıcının Türkçe isteğini MON/tTRY limit emrine çevirir.',
  input_schema: {
    type: 'object',
    properties: {
      understood: { type: 'boolean', description: 'İstek net bir alış/satış emri mi' },
      side: { type: 'string', enum: ['buy', 'sell'] },
      amount_mon: { type: 'number', description: 'MON miktarı' },
      price_try: { type: 'number', description: '1 MON için tTRY fiyatı' },
      explanation: { type: 'string', description: 'Kullanıcıya gösterilecek kısa Türkçe özet' },
    },
    required: ['understood', 'explanation'],
  },
};

async function aiOrder(text, market) {
  if (!env.ANTHROPIC_API_KEY) {
    const e = new Error('Yapay zeka kapalı: .env dosyasına ANTHROPIC_API_KEY ekle.');
    e.status = 503;
    throw e;
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.ANTHROPIC_API_KEY}`,
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.MODEL || 'claude-haiku-5-5',
      max_tokens: 1500,
      system: `Sen Pazar adlı zincir üstü borsanın emir asistanısın. Kullanıcının Türkçe isteğini MON/tTRY limit emrine çevir.
Piyasa durumu: en iyi alış ${market.bestBid ?? 'yok'} tTRY, en iyi satış ${market.bestAsk ?? 'yok'} tTRY, son fiyat ${market.last ?? 'yok'} tTRY.
Kurallar:
- "piyasadan al" → en iyi satış fiyatı; "piyasadan sat" → en iyi alış fiyatı; fiyat yoksa son fiyatı kullan.
- "%2 ucuza", "biraz altından" gibi göreli ifadeleri piyasa fiyatına göre hesapla, 2 ondalığa yuvarla.
- Tutar tTRY olarak verildiyse (ör. "500 liralık") MON miktarına çevir: miktar = tutar / fiyat, 4 ondalığa yuvarla.
- Yatırım tavsiyesi verme; sadece isteği emre çevir. İstek belirsizse understood=false ve kısa bir soru yaz.
- Sonucu create_order aracıyla bildir.`,
      tools: [ORDER_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: text.slice(0, 300) }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error?.message || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const tool = (data.content || []).find((b) => b.type === 'tool_use');
  let out = tool?.input;
  if (!out) {
    const m = (data.content || []).map((b) => b.text || '').join('').match(/\{[\s\S]*\}/);
    out = m ? JSON.parse(m[0]) : { understood: false, explanation: 'İsteği anlayamadım.' };
  }
  return {
    understood: Boolean(out.understood && out.side && out.amount_mon > 0 && out.price_try > 0),
    side: out.side === 'sell' ? 'sell' : 'buy',
    amount: Math.round(Number(out.amount_mon || 0) * 10000) / 10000,
    price: Math.round(Number(out.price_try || 0) * 100) / 100,
    explanation: String(out.explanation || '').slice(0, 200),
  };
}

// ───────────────────────── HTTP ─────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/config') {
      const d = readDeployment();
      if (!d) return send(res, 503, { error: 'Sözleşme henüz yüklenmedi: node scripts/pazar.mjs deploy' });
      return send(res, 200, { address: d.address, abi: d.abi, chainId: d.chainId, explorer: EXPLORER, ai: Boolean(env.ANTHROPIC_API_KEY) });
    }
    if (url.pathname === '/api/drip' && req.method === 'POST') {
      const { address } = JSON.parse(await readBody(req));
      if (!isAddress(address || '')) return send(res, 400, { error: 'Geçersiz adres' });
      return send(res, 200, await drip(address));
    }
    if (url.pathname === '/api/ai/order' && req.method === 'POST') {
      const { text, market } = JSON.parse(await readBody(req));
      if (!text?.trim()) return send(res, 400, { error: 'Boş istek' });
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const now = Date.now();
      while (aiLog.length && aiLog[0].t < now - 60 * 60 * 1000) aiLog.shift();
      if (aiLog.length >= AI_MAX_PER_HOUR || aiLog.filter((x) => x.ip === ip && x.t > now - 10 * 60 * 1000).length >= AI_PER_IP) {
        return send(res, 429, { error: 'Asistan şu an çok yoğun, birazdan tekrar dene ya da formu elle doldur.' });
      }
      aiLog.push({ ip, t: now });
      const t = Date.now();
      const out = await aiOrder(text, market || {});
      console.log(c.green('✓ Yapay zeka emri'), c.dim(`${Date.now() - t} ms: "${text}" → ${JSON.stringify(out)}`));
      return send(res, 200, out);
    }
    // Statik dosyalar
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Bulunamadı', 'text/plain');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.log(c.red('✗'), e.shortMessage || e.message);
    send(res, e.status && e.status < 600 ? e.status : 500, { error: e.shortMessage || e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const d = readDeployment();
  console.log(c.bold('\nPazar çalışıyor'));
  console.log(`Bu bilgisayarda:  ${c.green(`http://localhost:${PORT}/?kim=ayse`)}  ve  ${c.green(`http://localhost:${PORT}/?kim=mehmet`)}`);
  for (const ip of Object.values(os.networkInterfaces()).flat().filter((a) => a?.family === 'IPv4' && !a.internal)) {
    console.log(`Aynı ağdaki telefon: http://${ip.address}:${PORT}`);
  }
  console.log(d ? c.dim(`Sözleşme: ${d.address}`) : c.yellow('Sözleşme yok: node scripts/pazar.mjs deploy'));
  console.log(env.ANTHROPIC_API_KEY ? c.dim('Yapay zeka emir asistanı: açık') : c.dim('Yapay zeka emir asistanı: kapalı (.env yok)'));
  console.log(c.dim('Durdurmak için Ctrl+C\n'));
});
