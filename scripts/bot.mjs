// Piyasa botu: deftere canlılık katar (demo/video için)
//   node scripts/bot.mjs [dakika=4] [bot sayısı=3]
// Botlar kendi cüzdanlarıyla gerçek zincir işlemleri yapar: emir koyar, karşı emirleri alır,
// eski emirlerini iptal eder. Cüzdanlar .bot-keys.json'da saklanır (tekrar fonlamamak için).
import fs from 'node:fs';
import path from 'node:path';
import { formatEther, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { c, EXPLORER, operatorAccount, publicClient, readDeployment, ROOT, walletFor } from '../lib/chain.mjs';

const minutes = Number(process.argv[2] || 4);
const botCount = Math.min(5, Math.max(1, Number(process.argv[3] || 3)));
const d = readDeployment();
if (!d?.address) {
  console.log(c.red('Önce: node scripts/pazar.mjs deploy'));
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const read = (fn, args = []) => publicClient.readContract({ address: d.address, abi: d.abi, functionName: fn, args });
const LOT = 10n ** 14n; // 0,0001 MON
const amt = (lo, hi) => (BigInt(Math.round(rnd(lo, hi) * 10000)) * LOT); // MON → wei, 4 ondalık

async function send(wallet, functionName, args = [], value) {
  let hash;
  for (let attempt = 0; ; attempt++) {
    try {
      const req = { address: d.address, abi: d.abi, functionName, args, ...(value ? { value } : {}) };
      if (attempt > 0) req.gas = (await publicClient.estimateContractGas({ ...req, account: wallet.account })) + BigInt(attempt);
      hash = await wallet.writeContract(req);
      break;
    } catch (e) {
      const msg = `${e.details || ''} ${e.shortMessage || ''}`;
      if (attempt < 12 && /insufficient balance/i.test(msg)) {
        await sleep(800);
        continue;
      }
      throw e;
    }
  }
  const t = Date.now();
  const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (r.status !== 'success') throw new Error(`${functionName} geri çevrildi: ${EXPLORER}/tx/${hash}`);
  return { hash, ms: Date.now() - t };
}

// ───────── Bot cüzdanları ─────────
const KEYS = path.join(ROOT, '.bot-keys.json');
const NAMES = ['Bot Kuzgun', 'Bot Atmaca', 'Bot Doğan', 'Bot Şahin', 'Bot Kartal'];
let keys = fs.existsSync(KEYS) ? JSON.parse(fs.readFileSync(KEYS, 'utf8')) : [];
while (keys.length < botCount) keys.push(generatePrivateKey());
fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2));
const bots = keys.slice(0, botCount).map((k, i) => {
  const account = privateKeyToAccount(k);
  return { name: NAMES[i], account, wallet: walletFor(account) };
});

const op = operatorAccount();
const opWallet = walletFor(op);
const opStart = await publicClient.getBalance({ address: op.address });
console.log(c.bold(`\nPazar piyasa botu: ${botCount} bot, ${minutes} dakika`));
console.log(c.dim(`Operatör bakiyesi: ${Number(formatEther(opStart)).toFixed(3)} MON\n`));

// Hazırlık: gas için MON, borsaya MON, tTRY
for (const b of bots) {
  const bal = await publicClient.getBalance({ address: b.account.address });
  if (bal < parseEther('0.25')) {
    const h = await opWallet.sendTransaction({ to: b.account.address, value: parseEther('0.6') });
    const r = await publicClient.waitForTransactionReceipt({ hash: h, pollingInterval: 250 });
    if (r.status !== 'success') throw new Error('Bot fonlanamadı');
    console.log(c.dim(`${b.name}: 0,6 MON gönderildi`));
    await sleep(2500); // Monad reserve balance: operatör transferlerini arala
  }
}
await sleep(1500);
for (const b of bots) {
  const [monFree, tryFree] = await read('balancesOf', [b.account.address]);
  if (tryFree < parseEther('1000')) {
    try {
      await send(b.wallet, 'faucet');
    } catch {}
  }
  if (monFree < parseEther('0.05')) {
    await send(b.wallet, 'deposit', [], parseEther('0.25'));
  }
  console.log(c.green(`✓ ${b.name} hazır`), c.dim(b.account.address));
}

// ───────── Ana döngü ─────────
const end = Date.now() + minutes * 60 * 1000;
let trades = 0;
let orders = 0;
let errors = 0;
let anchor = null; // fiyatın etrafında gezindiği merkez (kuruş)

while (Date.now() < end) {
  const b = pick(bots);
  try {
    const [book, recent] = await Promise.all([read('book'), read('recentTrades', [1n])]);
    const asks = book.filter((o) => !o.isBuy).sort((x, y) => Number(x.price - y.price));
    const bids = book.filter((o) => o.isBuy).sort((x, y) => Number(y.price - x.price));
    const last = recent[0] ? Number(recent[0].price) : asks[0] && bids[0] ? Math.round((Number(asks[0].price) + Number(bids[0].price)) / 2) : 5000;
    anchor = anchor ?? last;
    anchor += Math.round(rnd(-12, 12)); // yavaş rastgele yürüyüş
    anchor = Math.round(anchor * 0.9 + last * 0.1);

    const [monFree, tryFree] = await read('balancesOf', [b.account.address]);
    const mine = book.filter((o) => o.owner.toLowerCase() === b.account.address.toLowerCase());

    // Defter dolmasın: botun 5'ten fazla açık emri varsa en eskisini iptal et
    if (mine.length > 5) {
      const oldest = mine.sort((x, y) => Number(x.createdAt - y.createdAt))[0];
      await send(b.wallet, 'cancel', [oldest.id]);
      console.log(c.dim(`${b.name}: eski emri iptal etti (#${oldest.id})`));
      await sleep(rnd(600, 1200));
      continue;
    }

    const roll = Math.random();
    const canSell = monFree > parseEther('0.01');
    const canBuy = tryFree > parseEther('5');
    if (roll < 0.55 && (asks[0] || bids[0])) {
      // Piyasa emri gibi: karşı tarafın en iyi fiyatından al/sat → işlem oluşur
      let buy = Math.random() < 0.5;
      if (buy && (!asks[0] || !canBuy)) buy = false;
      if (!buy && (!bids[0] || !canSell)) buy = true;
      const target = buy ? asks[0] : bids[0];
      if (!target || target.owner.toLowerCase() === b.account.address.toLowerCase()) throw new Error('skip');
      const a = amt(0.002, 0.008);
      const size = a < target.remaining ? a : target.remaining;
      const { ms } = await send(b.wallet, 'place', [buy, target.price, size]);
      trades++;
      console.log(`${buy ? c.green('AL ') : c.red('SAT')} ${b.name}: ${Number(formatEther(size)).toFixed(4)} MON @ ${(Number(target.price) / 100).toFixed(2)}  ${c.dim(`${(ms / 1000).toFixed(2)} sn`)}`);
    } else {
      // Deftere limit emir koy (likidite)
      let buy = Math.random() < 0.5;
      if (buy && !canBuy) buy = false;
      if (!buy && !canSell) buy = true;
      const offset = Math.round(rnd(15, 140));
      let price = buy ? anchor - offset : anchor + offset;
      // karşı tarafı geçmesin (yoksa anında eşleşir)
      if (buy && asks[0] && price >= Number(asks[0].price)) price = Number(asks[0].price) - 5;
      if (!buy && bids[0] && price <= Number(bids[0].price)) price = Number(bids[0].price) + 5;
      if (price < 100) price = 100;
      const size = amt(0.004, 0.02);
      await send(b.wallet, 'place', [buy, BigInt(price), size]);
      orders++;
      console.log(c.dim(`${buy ? 'alış ' : 'satış'} emri ${b.name}: ${Number(formatEther(size)).toFixed(4)} MON @ ${(price / 100).toFixed(2)}`));
    }
  } catch (e) {
    if (e.message !== 'skip') {
      errors++;
      console.log(c.yellow(`! ${b.name}: ${(e.details || e.shortMessage || e.message).split('\n')[0]}`));
    }
  }
  await sleep(rnd(900, 2200));
}

const opEnd = await publicClient.getBalance({ address: op.address });
console.log(c.bold(`\nBitti: ${trades} alım-satım, ${orders} yeni emir, ${errors} hata`));
console.log(c.dim(`Operatör bakiyesi: ${Number(formatEther(opEnd)).toFixed(3)} MON`));
for (const b of bots) {
  const w = await publicClient.getBalance({ address: b.account.address });
  console.log(c.dim(`${b.name} cüzdan: ${Number(formatEther(w)).toFixed(3)} MON`));
}
