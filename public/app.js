// Pazar web arayüzü — Monad testnet üzerinde zincir üstü emir defteri
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, parseEventLogs } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://testnet-rpc.monad.xyz';
const NAMES = { ayse: 'Ayşe', mehmet: 'Mehmet', ali: 'Ali', zeynep: 'Zeynep' };
const COLORS = { ayse: '#6e54ff', mehmet: '#0b8a5b', ali: '#d6453d', zeynep: '#e08a00' };
const LEVELS = 7;

const $ = (id) => document.getElementById(id);
const nf = (n, d = 2) => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const mon = (wei, d = 4) => nf(Number(formatEther(wei)), d);
const tryAmt = (wei) => nf(Number(formatEther(wei)), 2);
const price = (cents) => nf(Number(cents) / 100, 2);
const parseNum = (s) => Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

// ───────────────────────── Kimlik (persona) ve cüzdan ─────────────────────────
const kim = (new URLSearchParams(location.search).get('kim') || 'sen').toLowerCase().replace(/[^a-z0-9ğüşöçı]/g, '') || 'sen';
const displayName = NAMES[kim] || (kim === 'sen' ? 'Sen' : kim[0].toLocaleUpperCase('tr-TR') + kim.slice(1));

function loadKey() {
  const k = `pazar.key.${kim}`;
  try {
    let pk = localStorage.getItem(k);
    if (!pk) {
      pk = generatePrivateKey();
      localStorage.setItem(k, pk);
    }
    return pk;
  } catch {
    return generatePrivateKey(); // depolama kapalıysa oturumluk cüzdan
  }
}
const account = privateKeyToAccount(loadKey());
const me = account.address;

const chain = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 250 });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

// ───────────────────────── Durum ─────────────────────────
const st = {
  cfg: null,
  side: 'buy',
  book: [],
  trades: [],
  tradeCount: 0n,
  bal: { monFree: 0n, tryFree: 0n, monLocked: 0n, tryLocked: 0n },
  walletMon: 0n,
  stats: null,
  confirms: [],
  prevLevels: new Map(),
  prevMine: new Map(),
  lastTradeKey: null,
  busy: false,
  loaded: false,
};

// ───────────────────────── Zincir okuma ─────────────────────────
const read = (functionName, args = []) => pub.readContract({ address: st.cfg.address, abi: st.cfg.abi, functionName, args });

let polling = false;
async function refresh() {
  if (polling || !st.cfg) return;
  polling = true;
  try {
    const [book, trades, bal, stats, walletMon] = await Promise.all([
      read('book'),
      read('recentTrades', [50n]),
      read('balancesOf', [me]),
      read('stats'),
      pub.getBalance({ address: me }),
    ]);
    st.book = book;
    st.trades = trades;
    st.bal = { monFree: bal[0], tryFree: bal[1], monLocked: bal[2], tryLocked: bal[3] };
    st.stats = { orders: stats[0], trades: stats[1], volume: stats[2], open: stats[3] };
    st.walletMon = walletMon;
    detectMakerFills();
    render();
    if (!st.loaded) {
      st.loaded = true;
      maybeOnboard();
    }
  } catch (e) {
    console.warn('okuma hatası', e);
  } finally {
    polling = false;
  }
}

// Başkası benim bekleyen emrimi doldurduysa haber ver
function detectMakerFills() {
  const now = new Map(st.book.filter((o) => same(o.owner, me)).map((o) => [String(o.id), o]));
  if (st.loaded) {
    for (const [id, prev] of st.prevMine) {
      const cur = now.get(id);
      const remaining = cur ? cur.remaining : 0n;
      if (remaining < prev.remaining && !st.cancelling?.has(id)) {
        const filled = prev.remaining - remaining;
        toast(
          `${prev.isBuy ? 'Alış' : 'Satış'} emrin eşleşti: ${mon(filled)} MON @ ${price(prev.price)}${remaining === 0n ? ' (tamamı)' : ''}`,
          prev.isBuy ? 'buy' : 'sell',
        );
      }
    }
  }
  st.prevMine = now;
}

// ───────────────────────── İşlem gönderme ─────────────────────────
const ERRORS = {
  InsufficientBalance: 'Yetersiz bakiye.',
  BadAmount: "Miktar en az 0,001 MON olmalı ve en fazla 4 ondalık içermeli.",
  BadPrice: 'Geçersiz fiyat.',
  FaucetCooldown: 'Test-lira saatte bir alınabilir.',
  NotOwner: 'Bu emir senin değil.',
  NotOpen: 'Emir zaten kapanmış.',
};
function explain(e) {
  const text = `${e?.shortMessage || ''} ${e?.message || ''}`;
  for (const [k, v] of Object.entries(ERRORS)) if (text.includes(k)) return v;
  if (/insufficient funds/i.test(text)) return 'Cüzdanda işlem ücreti için yeterli MON yok.';
  console.error(e);
  const base = (e?.shortMessage || e?.message || 'İşlem başarısız.').split('\n')[0];
  return e?.details ? `${base} (${String(e.details).slice(0, 120)})` : base;
}

async function tx(label, functionName, args = [], value) {
  const chip = addChip(label);
  let started = performance.now();
  try {
    // Monad bakiyeyi birkaç blok gecikmeli durumdan kontrol eder: yeni gelen MON
    // ~1-2 sn görünmeyebilir. "insufficient balance" gelirse kısa bekleyip tekrar dene.
    // Not: aynı imzalı işlem aynı hash'i üretir ve RPC reddi önbellekte tutabilir;
    // bu yüzden her yeniden denemede gas limitini 1 artırıp farklı bir işlem gönderiyoruz.
    let hash;
    let baseGas;
    for (let attempt = 0; ; attempt++) {
      started = performance.now();
      try {
        const req = { address: st.cfg.address, abi: st.cfg.abi, functionName, args, ...(value ? { value } : {}) };
        if (attempt > 0) {
          baseGas ??= await pub.estimateContractGas({ ...req, account });
          req.gas = baseGas + BigInt(attempt);
        }
        hash = await wallet.writeContract(req);
        break;
      } catch (e) {
        const msg = `${e.details || ''} ${e.shortMessage || ''} ${e.message || ''}`;
        if (attempt < 20 && /insufficient balance/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw e;
      }
    }
    const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 200 });
    const ms = performance.now() - started;
    if (receipt.status !== 'success') throw new Error('İşlem zincirde geri çevrildi.');
    st.confirms.push(ms);
    finishChip(chip, label, ms, hash);
    refresh();
    return { hash, ms, receipt };
  } catch (e) {
    failChip(chip, label);
    throw e;
  }
}

// ───────────────────────── Emir formu ─────────────────────────
function setSide(side) {
  st.side = side;
  $('tabBuy').classList.toggle('active', side === 'buy');
  $('tabSell').classList.toggle('active', side === 'sell');
  $('tabBuy').setAttribute('aria-selected', side === 'buy');
  $('tabSell').setAttribute('aria-selected', side === 'sell');
  const btn = $('submitBtn');
  btn.classList.toggle('buy', side === 'buy');
  btn.classList.toggle('sell', side === 'sell');
  updateTotal();
}

function updateTotal() {
  const p = parseNum($('price').value);
  const a = parseNum($('amount').value);
  const t = p > 0 && a > 0 ? p * a : 0;
  $('total').textContent = `${nf(t)} tTRY`;
  const verb = st.side === 'buy' ? 'Al' : 'Sat';
  $('submitBtn').textContent = a > 0 && p > 0 ? `${nf(a, a < 0.01 ? 4 : 3)} MON ${verb.toLocaleLowerCase('tr-TR')}` : verb;
}

function formMsg(text, kind = '') {
  $('formMsg').textContent = text;
  $('formMsg').className = `form-msg ${kind}`;
}

async function submitOrder(ev) {
  ev.preventDefault();
  if (st.busy) return;
  const p = parseNum($('price').value);
  const a = parseNum($('amount').value);
  if (!(p > 0)) return formMsg('Fiyat gir.', 'err');
  if (!(a >= 0.001)) return formMsg('Miktar en az 0,001 MON olmalı.', 'err');
  const cents = Math.round(p * 100);
  const amountWei = parseEther((Math.round(a * 10000) / 10000).toFixed(4));
  const isBuy = st.side === 'buy';

  // Bakiye ön kontrolü
  if (isBuy && st.bal.tryFree < (amountWei * BigInt(cents)) / 100n) return formMsg('Yetersiz tTRY bakiyesi.', 'err');
  if (!isBuy && st.bal.monFree < amountWei) return formMsg('Borsada yeterli serbest MON yok. Bakiye menüsünden yatır.', 'err');

  st.busy = true;
  $('submitBtn').disabled = true;
  formMsg("Monad'a gönderiliyor…");
  const label = `${isBuy ? 'Alış' : 'Satış'} ${nf(a, 4)} MON @ ${nf(p)}`;
  try {
    const { ms, receipt } = await tx(label, 'place', [isBuy, cents, amountWei]);
    const logs = parseEventLogs({ abi: st.cfg.abi, logs: receipt.logs });
    const fills = logs.filter((l) => l.eventName === 'Traded');
    const placed = logs.find((l) => l.eventName === 'OrderPlaced');
    const filled = fills.reduce((s, l) => s + l.args.amount, 0n);
    const secs = nf(ms / 1000, 2);
    if (fills.length) {
      const avg = fills.reduce((s, l) => s + l.args.amount * BigInt(l.args.price), 0n) / filled;
      toast(`${mon(filled)} MON ${isBuy ? 'alındı' : 'satıldı'}, ort. ${price(avg)} tTRY (${fills.length} eşleşme, ${secs} sn)`, isBuy ? 'buy' : 'sell');
    }
    if (placed && placed.args.rested > 0n) formMsg(`${mon(placed.args.rested)} MON deftere yazıldı (${secs} sn).`, 'ok');
    else formMsg(`Tamamen eşleşti (${secs} sn).`, 'ok');
    $('amount').value = '';
    updateTotal();
  } catch (e) {
    formMsg(explain(e), 'err');
  } finally {
    st.busy = false;
    $('submitBtn').disabled = false;
  }
}

function fillPct(pct) {
  const p = parseNum($('price').value) || (st.trades[0] ? Number(st.trades[0].price) / 100 : 0);
  let a;
  if (st.side === 'buy') {
    if (!p) return formMsg('Önce fiyat gir.', 'err');
    a = (Number(formatEther(st.bal.tryFree)) * pct) / 100 / p;
  } else {
    a = (Number(formatEther(st.bal.monFree)) * pct) / 100;
  }
  a = Math.floor(a * 10000) / 10000;
  $('amount').value = nf(a, 4);
  updateTotal();
}

async function cancelOrder(id) {
  st.cancelling ??= new Set();
  st.cancelling.add(String(id));
  try {
    await tx(`Emir #${id} iptal`, 'cancel', [id]);
    toast('Emir iptal edildi, kilitli bakiye iade edildi.');
  } catch (e) {
    toast(explain(e));
  } finally {
    setTimeout(() => st.cancelling.delete(String(id)), 3000);
  }
}

// ───────────────────────── Yapay zeka emir asistanı ─────────────────────────
function market() {
  const asks = st.book.filter((o) => !o.isBuy).map((o) => Number(o.price));
  const bids = st.book.filter((o) => o.isBuy).map((o) => Number(o.price));
  return {
    bestAsk: asks.length ? Math.min(...asks) / 100 : null,
    bestBid: bids.length ? Math.max(...bids) / 100 : null,
    last: st.trades[0] ? Number(st.trades[0].price) / 100 : null,
  };
}

async function aiTranslate() {
  const text = $('aiInput').value.trim();
  if (!text) return;
  const out = $('aiOut');
  out.hidden = false;
  out.className = 'ai-out';
  out.textContent = 'Yapay zeka düşünüyor…';
  $('aiBtn').disabled = true;
  try {
    const res = await fetch('/api/ai/order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, market: market() }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Yapay zeka yanıt vermedi');
    if (!r.understood) {
      out.className = 'ai-out err';
      out.textContent = r.explanation || 'İsteği anlayamadım, biraz daha açık yazar mısın?';
      return;
    }
    setSide(r.side);
    $('price').value = nf(r.price, 2);
    $('amount').value = nf(r.amount, 4);
    updateTotal();
    out.textContent = `${r.explanation} Kontrol edip butona bas.`;
  } catch (e) {
    out.className = 'ai-out err';
    out.textContent = e.message;
  } finally {
    $('aiBtn').disabled = false;
  }
}

// ───────────────────────── Çizim ─────────────────────────
function levels(isBuy) {
  const map = new Map();
  for (const o of st.book) {
    if (o.isBuy !== isBuy) continue;
    const k = Number(o.price);
    const l = map.get(k) || { price: k, amount: 0n, mine: false };
    l.amount += o.remaining;
    l.mine ||= same(o.owner, me);
    map.set(k, l);
  }
  const arr = [...map.values()].sort((a, b) => (isBuy ? b.price - a.price : a.price - b.price));
  return arr.slice(0, LEVELS);
}

function renderBook() {
  const asks = levels(false);
  const bids = levels(true);
  const max = [...asks, ...bids].reduce((m, l) => (l.amount > m ? l.amount : m), 1n);
  const row = (l, side) => {
    const key = `${side}${l.price}`;
    const changed = st.prevLevels.has(key) && st.prevLevels.get(key) !== l.amount;
    st.prevLevels.set(key, l.amount);
    const w = Number((l.amount * 1000n) / max) / 10;
    const total = (l.amount * BigInt(l.price)) / 100n;
    return `<div class="lvl${l.mine ? ' mine' : ''}${changed ? ' flash' : ''}" data-price="${l.price}" data-amount="${l.amount}">
      <div class="depth" style="width:${w}%"></div>
      <span>${price(l.price)}</span><span>${mon(l.amount)}</span><span>${tryAmt(total)}</span></div>`;
  };
  $('asks').innerHTML = asks.length ? [...asks].reverse().map((l) => row(l, 'a')).join('') : '<div class="empty-side">Satış emri yok</div>';
  $('bids').innerHTML = bids.length ? bids.map((l) => row(l, 'b')).join('') : '<div class="empty-side">Alış emri yok</div>';
  if (asks.length && bids.length) {
    const spread = asks[0].price - bids[0].price;
    const mid = (asks[0].price + bids[0].price) / 2;
    $('spread').innerHTML = `<span>Orta fiyat</span><b>${price(mid)}</b><span>Fark ${price(spread)}</span>`;
  } else {
    $('spread').innerHTML = '<span>Defter boş, ilk emri sen ver</span>';
  }
}

function renderTrades() {
  const list = st.trades;
  const key = list[0] ? `${list[0].time}-${list[0].price}-${list[0].amount}-${st.stats?.trades}` : null;
  const fresh = st.lastTradeKey !== null && key !== st.lastTradeKey;
  st.lastTradeKey = key;
  if (!list.length) {
    $('trades').innerHTML = '<div class="empty-side">Henüz işlem yok</div>';
    return;
  }
  $('trades').innerHTML = list
    .slice(0, 30)
    .map((t, i) => {
      const prev = list[i + 1];
      const dir = !prev || t.price >= prev.price ? 'up' : 'down';
      const time = new Date(Number(t.time) * 1000).toLocaleTimeString('tr-TR');
      const mine = same(t.maker, me) || same(t.taker, me);
      return `<div class="trade${mine ? ' me' : ''}${fresh && i === 0 ? ' new' : ''}">
        <span class="${dir}">${price(t.price)}</span><span>${mon(t.amount)}</span><span>${time}</span></div>`;
    })
    .join('');
}

function renderMine() {
  const mine = st.book.filter((o) => same(o.owner, me)).sort((a, b) => Number(b.id - a.id));
  $('mineCount').textContent = mine.length ? `${mine.length} açık` : '';
  $('mine').innerHTML = mine.length
    ? mine
        .map(
          (o) => `<div class="mine-row">
        <span class="side ${o.isBuy ? 'buy' : 'sell'}">${o.isBuy ? 'AL' : 'SAT'}</span>
        <span class="num">${mon(o.remaining)} MON @ ${price(o.price)}</span>
        <button data-cancel="${o.id}">İptal</button></div>`,
        )
        .join('')
    : '<div class="empty-side">Bekleyen emrin yok</div>';
}

function renderHeader() {
  const t = st.trades;
  const lp = $('lastPrice');
  if (t[0]) {
    lp.textContent = price(t[0].price);
    lp.classList.toggle('up', !t[1] || t[0].price >= t[1].price);
    lp.classList.toggle('down', Boolean(t[1] && t[0].price < t[1].price));
  }
  if (st.stats) {
    $('statOrders').textContent = Number(st.stats.orders).toLocaleString('tr-TR');
    $('statTrades').textContent = Number(st.stats.trades).toLocaleString('tr-TR');
    $('statVolume').textContent = `${mon(st.stats.volume, 3)} MON`;
  }
  if (st.confirms.length) {
    const avg = st.confirms.reduce((s, x) => s + x, 0) / st.confirms.length;
    $('statConfirm').textContent = `${nf(avg / 1000, 2)} sn`;
  }
  $('balMon').textContent = mon(st.bal.monFree, 3);
  $('balTry').textContent = tryAmt(st.bal.tryFree);
  $('walletMon').textContent = `${mon(st.walletMon)} MON`;
  $('freeMon').textContent = `${mon(st.bal.monFree)} MON`;
  $('lockedMon').textContent = `${mon(st.bal.monLocked)} MON`;
  $('freeTry').textContent = `${tryAmt(st.bal.tryFree)} tTRY`;
  $('lockedTry').textContent = `${tryAmt(st.bal.tryLocked)} tTRY`;
}

const TF_LABEL = { 60: '1 dakika', 300: '5 dakika', 900: '15 dakika', 3600: '1 saat' };
let chartTf = 300;

function renderChart() {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px "JetBrains Mono", monospace';

  // işlemler: eskiden yeniye, zaman (sn) ve fiyat (tTRY)
  const trades = [...st.trades].reverse().map((t) => ({ t: Number(t.time), p: Number(t.price) / 100 }));
  if (!trades.length) {
    ctx.fillStyle = '#6b7080';
    ctx.textAlign = 'center';
    ctx.fillText('Henüz işlem yok', w / 2, h / 2);
    return;
  }
  const now = Math.max(Date.now() / 1000, trades[trades.length - 1].t);
  const t0 = now - chartTf;
  // pencere başındaki fiyat: pencereden önceki son işlem
  const before = trades.filter((x) => x.t < t0);
  const inside = trades.filter((x) => x.t >= t0);
  const pts = [];
  if (before.length) pts.push({ t: t0, p: before[before.length - 1].p });
  pts.push(...inside);
  if (!pts.length) pts.push({ t: t0, p: trades[trades.length - 1].p });
  pts.push({ t: now, p: pts[pts.length - 1].p }); // son fiyat şimdiye kadar uzar

  const tStart = pts[0].t;
  let lo = Math.min(...pts.map((x) => x.p));
  let hi = Math.max(...pts.map((x) => x.p));
  if (hi - lo < 0.5) {
    hi += 0.25;
    lo -= 0.25;
  }
  const padL = 8, padR = 64, padT = 12, padB = 22;
  const x = (t) => padL + ((t - tStart) / Math.max(1, now - tStart)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  // ızgara + fiyat ekseni
  ctx.strokeStyle = '#eceef3';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#6b7080';
  ctx.textAlign = 'left';
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(padL, y(v));
    ctx.lineTo(w - padR, y(v));
    ctx.stroke();
    ctx.fillText(nf(v), w - padR + 8, y(v) + 4);
  }
  // zaman ekseni
  ctx.textAlign = 'center';
  const fmtT = (t) =>
    new Date(t * 1000).toLocaleTimeString('tr-TR', chartTf <= 300 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  for (let i = 0; i <= 4; i++) {
    const t = tStart + ((now - tStart) * i) / 4;
    const xx = Math.min(Math.max(x(t), padL + 26), w - padR - 26);
    ctx.fillText(fmtT(t), xx, h - 6);
  }

  // basamaklı çizgi: fiyat bir sonraki işleme kadar sabit
  const path = () => {
    ctx.beginPath();
    pts.forEach((pt, i) => {
      if (!i) return ctx.moveTo(x(pt.t), y(pt.p));
      ctx.lineTo(x(pt.t), y(pts[i - 1].p));
      ctx.lineTo(x(pt.t), y(pt.p));
    });
  };
  const up = pts[pts.length - 1].p >= pts[0].p;
  const color = up ? '#0b8a5b' : '#d6453d';
  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, up ? 'rgba(11,138,91,0.16)' : 'rgba(214,69,61,0.16)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  path();
  ctx.lineTo(x(now), h - padB);
  ctx.lineTo(x(tStart), h - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  path();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  // işlem noktaları
  ctx.fillStyle = color;
  for (const pt of inside) {
    ctx.beginPath();
    ctx.arc(x(pt.t), y(pt.p), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // son fiyat etiketi
  const last = pts[pts.length - 1].p;
  const ly = y(last);
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, ly);
  ctx.lineTo(w - padR, ly);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.fillRect(w - padR + 2, ly - 9, padR - 4, 18);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.fillText(nf(last), w - padR + 7, ly + 4);
  $('chartHint').textContent = `${inside.length} işlem · son ${TF_LABEL[chartTf]}`;
}

function render() {
  renderHeader();
  renderBook();
  renderTrades();
  renderMine();
  renderChart();
}

// ───────────────────────── İşlem akışı ve bildirim ─────────────────────────
function addChip(label) {
  const log = $('txlog');
  log.querySelector('.muted')?.remove();
  const el = document.createElement('span');
  el.className = 'tx pending';
  el.textContent = `${label} · gönderiliyor…`;
  log.prepend(el);
  while (log.children.length > 8) log.lastChild.remove();
  return el;
}
function finishChip(el, label, ms, hash) {
  const a = document.createElement('a');
  a.className = 'tx';
  a.href = `${st.cfg.explorer}/tx/${hash}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.innerHTML = `${label} <b>${nf(ms / 1000, 2)} sn</b> ↗`;
  el.replaceWith(a);
}
function failChip(el, label) {
  el.className = 'tx fail';
  el.textContent = `${label} · başarısız`;
}

let toastTimer;
function toast(text, kind = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ───────────────────────── Başlangıç (hesap hazırlama) ─────────────────────────
function maybeOnboard() {
  const b = st.bal;
  const missing = b.monFree + b.monLocked === 0n || b.tryFree + b.tryLocked === 0n;
  if (!missing) return;
  $('obName').textContent = displayName;
  $('onboard').hidden = false;
}

function stepState(name, state, text) {
  const li = document.querySelector(`[data-step="${name}"]`);
  li.className = state;
  if (text !== undefined) li.querySelector('.t').textContent = text;
}

async function onboard() {
  const btn = $('obBtn');
  btn.disabled = true;
  try {
    // 1) MON damlası
    stepState('drip', 'run');
    const t0 = performance.now();
    if (st.walletMon < parseEther('0.5')) {
      const res = await fetch('/api/drip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: me }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'MON gönderilemedi');
      // bakiye görünene kadar bekle (en fazla ~20 sn)
      let ok = false;
      for (let i = 0; i < 40; i++) {
        if ((await pub.getBalance({ address: me })) >= parseEther('0.5')) { ok = true; break; }
        await new Promise((x) => setTimeout(x, 500));
      }
      if (!ok) throw new Error(r.reason || 'Test MON cüzdana ulaşmadı. Sunucu penceresindeki mesaja bak.');
      // Monad bakiye kontrolü birkaç blok geriden gelir; kısa pay bırak
      await new Promise((x) => setTimeout(x, 3000));
    }
    stepState('drip', 'done', `${nf((performance.now() - t0) / 1000, 2)} sn`);
    // 2) tTRY (değersiz işlem önce: Monad'da yeni cüzdanın ilk işlemi böyle sorunsuz geçiyor)
    stepState('faucet', 'run');
    if (st.bal.tryFree + st.bal.tryLocked === 0n) {
      const f = await tx('10.000 tTRY alındı', 'faucet');
      stepState('faucet', 'done', `${nf(f.ms / 1000, 2)} sn`);
    } else stepState('faucet', 'done', 'var');
    // 3) Yatır
    stepState('deposit', 'run');
    if (st.bal.monFree + st.bal.monLocked === 0n) {
      const d = await tx('0,2 MON yatırıldı', 'deposit', [], parseEther('0.2'));
      stepState('deposit', 'done', `${nf(d.ms / 1000, 2)} sn`);
    } else stepState('deposit', 'done', 'var');
    btn.textContent = 'Hazır, başla';
    btn.disabled = false;
    btn.onclick = () => ($('onboard').hidden = true);
  } catch (e) {
    const running = document.querySelector('.steps li.run');
    if (running) running.className = 'fail';
    btn.textContent = 'Tekrar dene';
    btn.disabled = false;
    toast(explain(e));
  }
}

// ───────────────────────── Bağlantılar ─────────────────────────
function bind() {
  $('meName').textContent = displayName;
  $('avatar').textContent = displayName[0];
  $('avatar').style.background = COLORS[kim] || '#14151a';
  $('meAddr').textContent = short(me);
  $('meAddr').onclick = async () => {
    try {
      await navigator.clipboard.writeText(me);
      toast('Adres kopyalandı');
    } catch {
      toast(me);
    }
  };
  document.title = `${displayName} · Pazar`;

  $('tabBuy').onclick = () => setSide('buy');
  $('tabSell').onclick = () => setSide('sell');
  $('price').oninput = updateTotal;
  $('amount').oninput = updateTotal;
  $('orderForm').onsubmit = submitOrder;
  document.querySelectorAll('[data-pct]').forEach((b) => (b.onclick = () => fillPct(Number(b.dataset.pct))));

  const clickLevel = (e) => {
    const lvl = e.target.closest('.lvl');
    if (!lvl) return;
    const p = Number(lvl.dataset.price) / 100;
    $('price').value = nf(p);
    // satış tarafına tıklayınca al, alış tarafına tıklayınca sat (karşı tarafı al)
    setSide(lvl.parentElement.id === 'asks' ? 'buy' : 'sell');
    // o fiyattaki toplam miktarı da gir (4 ondalığa yuvarla)
    const amt = Number(formatEther(BigInt(lvl.dataset.amount || '0')));
    $('amount').value = nf(Math.floor(amt * 10000) / 10000, 4);
    updateTotal();
    $('amount').focus();
  };
  $('asks').onclick = clickLevel;
  $('bids').onclick = clickLevel;
  $('mine').onclick = (e) => {
    const id = e.target.dataset?.cancel;
    if (id) cancelOrder(BigInt(id));
  };

  $('aiBtn').onclick = aiTranslate;
  $('aiInput').onkeydown = (e) => {
    if (e.key === 'Enter') aiTranslate();
  };

  $('moreBtn').onclick = () => ($('popover').hidden = !$('popover').hidden);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.me')) $('popover').hidden = true;
  });
  $('depositBtn').onclick = async () => {
    try {
      await tx('0,1 MON yatırıldı', 'deposit', [], parseEther('0.1'));
    } catch (e) {
      toast(explain(e));
    }
  };
  $('withdrawBtn').onclick = async () => {
    if (st.bal.monFree === 0n) return toast('Çekilecek serbest MON yok.');
    try {
      await tx(`${mon(st.bal.monFree)} MON çekildi`, 'withdraw', [st.bal.monFree]);
    } catch (e) {
      toast(explain(e));
    }
  };
  $('faucetBtn').onclick = async () => {
    try {
      await tx('10.000 tTRY alındı', 'faucet');
    } catch (e) {
      toast(explain(e));
    }
  };
  $('obBtn').onclick = onboard;
  window.addEventListener('resize', renderChart);
  $('tf').onclick = (e) => {
    const b = e.target.closest('button[data-tf]');
    if (!b) return;
    chartTf = Number(b.dataset.tf);
    for (const x of $('tf').querySelectorAll('button')) x.classList.toggle('active', x === b);
    renderChart();
  };
  setSide('buy');
}

async function start() {
  bind();
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (!res.ok) throw new Error(cfg.error);
    st.cfg = cfg;
    if (!cfg.ai) {
      $('aiInput').placeholder = 'Yapay zeka kapalı (.env içinde ANTHROPIC_API_KEY yok)';
      $('aiInput').disabled = true;
      $('aiBtn').disabled = true;
    }
  } catch (e) {
    toast(`Yapılandırma okunamadı: ${e.message}`);
    return;
  }
  await refresh();
  setInterval(refresh, 1000);
}

start();
