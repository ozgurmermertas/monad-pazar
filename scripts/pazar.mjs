// Pazar yardımcı betiği
//
//   node scripts/pazar.mjs wallet      → operatör cüzdanını gösterir (faucet'ten MON alması için)
//   node scripts/pazar.mjs compile     → sözleşmeyi derler
//   node scripts/pazar.mjs deploy      → derler ve Monad testnet'e yükler (deployment.json yazar)
//   node scripts/pazar.mjs selftest    → iki yeni cüzdanla zincir üstünde uçtan uca test
//   node scripts/pazar.mjs seed        → deftere başlangıç alış/satış emirleri koyar
//   node scripts/pazar.mjs stats       → emir, işlem, hacim sayıları
//   node scripts/pazar.mjs fund <adres> [MON]

import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { formatEther, isAddress, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  c,
  DEPLOYMENT_FILE,
  EXPLORER,
  FAUCET_URL,
  monadTestnet,
  operatorAccount,
  publicClient,
  readDeployment,
  ROOT,
  secs,
  walletFor,
} from '../lib/chain.mjs';

const fmt = (wei, d = 4) => Number(formatEther(wei)).toLocaleString('tr-TR', { maximumFractionDigits: d });

function compile() {
  const file = 'Pazar.sol';
  const content = fs.readFileSync(path.join(ROOT, 'contracts', file), 'utf8');
  const build = (viaIR) =>
    JSON.parse(
      solc.compile(
        JSON.stringify({
          language: 'Solidity',
          sources: { [file]: { content } },
          settings: {
            optimizer: { enabled: true, runs: 200 },
            evmVersion: 'paris',
            viaIR,
            outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
          },
        }),
      ),
    );
  let out = build(false);
  let errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.some((e) => /Stack too deep/.test(e.message))) {
    out = build(true);
    errors = (out.errors || []).filter((e) => e.severity === 'error');
  }
  if (errors.length) {
    for (const e of errors) console.log(e.formattedMessage);
    console.log(c.red("Derleme hatası. Ekranın fotoğrafını Claude'a gönder."));
    process.exit(1);
  }
  const ct = out.contracts[file].Pazar;
  console.log(c.green(`✓ Pazar derlendi (solc ${solc.version().split('+')[0]})`));
  return { abi: ct.abi, bytecode: `0x${ct.evm.bytecode.object}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(wallet, d, functionName, args = [], value) {
  let started = Date.now();
  let hash;
  // Monad bakiyeyi birkaç blok gecikmeli durumdan kontrol eder; yeni fonlanan
  // cüzdanda ilk işlem "insufficient balance" alabilir → kısa bekleyip tekrar dene.
  for (let attempt = 0; ; attempt++) {
    started = Date.now();
    try {
      const req = { address: d.address, abi: d.abi, functionName, args, ...(value ? { value } : {}) };
      // aynı işlem aynı hash'i üretir ve RPC reddi önbellekte kalabilir → denemede gas'ı 1 artır
      if (attempt > 0) req.gas = (await publicClient.estimateContractGas({ ...req, account: wallet.account })) + BigInt(attempt);
      hash = await wallet.writeContract(req);
      if (attempt > 0) console.log(c.dim(' tamam)'));
      break;
    } catch (e) {
      const msg = `${e.details || ''} ${e.shortMessage || ''} ${e.message || ''}`;
      if (attempt < 20 && /insufficient balance/i.test(msg)) {
        if (attempt === 0) process.stdout.write(c.dim(`  (${functionName}: bakiye henüz görünmüyor, bekleniyor`));
        process.stdout.write(c.dim('.'));
        await sleep(750);
        continue;
      }
      if (attempt > 0) console.log(')');
      // Teşhis bilgisi
      try {
        const addr = wallet.account.address;
        const [bal, fees, gas] = await Promise.all([
          publicClient.getBalance({ address: addr }),
          publicClient.estimateFeesPerGas(),
          publicClient.estimateContractGas({ address: d.address, abi: d.abi, functionName, args, account: wallet.account, ...(value ? { value } : {}) }).catch((x) => `tahmin edilemedi: ${x.shortMessage || x.message}`),
        ]);
        console.log(c.dim(`\n  Teşhis → cüzdan ${addr}\n  bakiye ${formatEther(bal)} MON, gas ${gas}, maxFeePerGas ${fees.maxFeePerGas} wei, değer ${value ? formatEther(value) : 0}`));
        if (typeof gas === 'bigint') console.log(c.dim(`  gereken en fazla ücret ≈ ${formatEther(gas * fees.maxFeePerGas)} MON`));
      } catch {}
      throw e;
    }
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (receipt.status !== 'success') throw new Error(`${functionName} başarısız: ${EXPLORER}/tx/${hash}`);
  return { hash, ms: Date.now() - started };
}

const read = (d, functionName, args = []) => publicClient.readContract({ address: d.address, abi: d.abi, functionName, args });

function need() {
  const d = readDeployment();
  if (!d?.address) {
    console.log(c.red('Önce: node scripts/pazar.mjs deploy'));
    process.exit(1);
  }
  return d;
}

// ───────────────────────── Komutlar ─────────────────────────

async function cmdWallet() {
  const acc = operatorAccount();
  const bal = await publicClient.getBalance({ address: acc.address });
  console.log(`\n${c.bold('Operatör cüzdanı:')} ${acc.address}`);
  console.log(`${c.bold('Bakiye:')} ${fmt(bal)} MON`);
  if (bal === 0n) console.log(c.yellow(`MON yok. ${FAUCET_URL} adresinden bu adrese test MON'u al.`));
  console.log('');
}

async function cmdDeploy() {
  const acc = operatorAccount();
  if ((await publicClient.getBalance({ address: acc.address })) === 0n) {
    console.log(c.red(`Operatör cüzdanında MON yok. Faucet: ${FAUCET_URL}  Adres: ${acc.address}`));
    process.exit(1);
  }
  const { abi, bytecode } = compile();
  console.log("Monad testnet'e yükleniyor...");
  const started = Date.now();
  const hash = await walletFor(acc).deployContract({ abi, bytecode });
  const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`Yükleme başarısız: ${EXPLORER}/tx/${hash}`);
  fs.writeFileSync(
    DEPLOYMENT_FILE,
    JSON.stringify(
      { address: r.contractAddress, chainId: monadTestnet.id, txHash: hash, blockNumber: Number(r.blockNumber), deployedAt: new Date().toISOString(), abi },
      null,
      2,
    ),
  );
  console.log(c.green(`✓ Yüklendi (${secs(Date.now() - started)} sn): ${r.contractAddress}`));
  console.log(`${EXPLORER}/address/${r.contractAddress}`);
  console.log(c.green('✓ deployment.json yazıldı. Sıradaki: node scripts/pazar.mjs selftest\n'));
}

async function cmdSelftest() {
  const d = need();
  const op = operatorAccount();
  const opWallet = walletFor(op);
  const A = privateKeyToAccount(generatePrivateKey());
  const B = privateKeyToAccount(generatePrivateKey());
  const wa = walletFor(A);
  const wb = walletFor(B);
  const times = [];
  let failures = 0;
  const check = (label, cond) => {
    console.log(`  ${cond ? c.green('✓') : c.red('✗')} ${label}`);
    if (!cond) failures++;
  };
  const step = async (label, fn) => {
    const r = await fn();
    times.push(r.ms);
    console.log(`${c.bold(label)} ${c.dim(`${secs(r.ms)} sn`)}`);
    return r;
  };

  console.log(c.bold('\nPazar zincir üstü öz-test (iki yeni cüzdan: A ve B)\n'));

  // Fiyat: defterdeki hiçbir emirle çakışmayan bir değer seç
  const book = await read(d, 'book');
  const bids = book.filter((o) => o.isBuy).map((o) => Number(o.price));
  const asks = book.filter((o) => !o.isBuy).map((o) => Number(o.price));
  const bestBid = bids.length ? Math.max(...bids) : 0;
  const bestAsk = asks.length ? Math.min(...asks) : 10_000_00;
  const p = Math.floor((bestBid + bestAsk) / 2);
  if (!(p > bestBid && p < bestAsk)) {
    console.log(c.red('Defterdeki fiyat aralığı çok dar; öz-testi boş defterle (seed öncesi) çalıştır.'));
    process.exit(1);
  }
  const P = BigInt(p);
  const q = (amt) => (amt * P) / 100n;
  console.log(c.dim(`Test fiyatı: ${(p / 100).toFixed(2)} tTRY`));

  const fundAmt = parseEther('0.3'); // Monad işlem ücretini gas limiti üzerinden ayırır; pay bırak
  for (const [name, acc] of [['A', A], ['B', B]]) {
    await step(`${name} cüzdanına 0,3 MON gönderildi`, async () => {
      const t = Date.now();
      const hash = await opWallet.sendTransaction({ to: acc.address, value: fundAmt });
      const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
      if (r.status !== 'success') throw new Error(`MON gönderimi geri çevrildi: ${EXPLORER}/tx/${hash}`);
      return { ms: Date.now() - t };
    });
    // Monad "reserve balance" kuralı: bakiyesi 10 MON'un altındaki bir cüzdan, son birkaç
    // blokta işlemi varsa değer transferiyle bakiyesini düşüremez. Operatör işlemlerini arala.
    await sleep(2000);
  }
  await sleep(1000);
  await step('A: 0,02 MON yatırdı', () => send(wa, d, 'deposit', [], parseEther('0.02')));
  await step('B: tTRY faucet', () => send(wb, d, 'faucet'));

  const bal = async (acc) => {
    const [monFree, tryFree, monLocked, tryLocked] = await read(d, 'balancesOf', [acc.address]);
    return { monFree, tryFree, monLocked, tryLocked };
  };
  const a0 = await bal(A);
  const b0 = await bal(B);

  const s1 = parseEther('0.01');
  await step(`A: 0,01 MON satış emri @ ${(p / 100).toFixed(2)}`, () => send(wa, d, 'place', [false, p, s1]));
  const a1 = await bal(A);
  check('A: 0,01 MON kilitlendi', a1.monLocked === s1 && a1.monFree === a0.monFree - s1);

  const b1amt = parseEther('0.004');
  await step('B: 0,004 MON alış emri (kısmi eşleşme)', () => send(wb, d, 'place', [true, p, b1amt]));
  const a2 = await bal(A);
  const b2 = await bal(B);
  check('B: 0,004 MON aldı', b2.monFree === b1amt);
  check('B: doğru tTRY ödedi', b2.tryFree === b0.tryFree - q(b1amt));
  check('A: satış tutarını aldı', a2.tryFree === a1.tryFree + q(b1amt));
  check("A'nın emrinde 0,006 MON kaldı", a2.monLocked === s1 - b1amt);

  const b3amt = parseEther('0.01');
  await step('B: 0,01 MON alış (0,006 eşleşir, 0,004 deftere yazılır)', () => send(wb, d, 'place', [true, p, b3amt]));
  const a3 = await bal(A);
  const b3 = await bal(B);
  check("A'nın satış emri tamamen doldu", a3.monLocked === 0n);
  check('B: toplam 0,01 MON aldı', b3.monFree === s1);
  check('B: 0,004 MON karşılığı tTRY kilitli', b3.tryLocked === q(parseEther('0.004')));

  const myOrder = (await read(d, 'book')).find((o) => o.owner.toLowerCase() === B.address.toLowerCase());
  check('B: bekleyen emri defterde', Boolean(myOrder));
  if (myOrder) {
    await step('B: emrini iptal etti', () => send(wb, d, 'cancel', [myOrder.id]));
    const b4 = await bal(B);
    check('B: kilitli tTRY iade edildi', b4.tryLocked === 0n && b4.tryFree === b0.tryFree - q(s1));
  }

  await step('A: 0,005 MON çekti', () => send(wa, d, 'withdraw', [parseEther('0.005')]));
  const a5 = await bal(A);
  check('A: çekilen MON bakiyeden düştü', a5.monFree === a0.monFree - s1 - parseEther('0.005'));

  const trades = await read(d, 'recentTrades', [5n]);
  check('Son işlemler listesinde 2 yeni işlem', trades.length >= 2 && trades[0].taker.toLowerCase() === B.address.toLowerCase());

  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  console.log(`\n${times.length} işlem, ortalama onay süresi ${c.bold(`${secs(avg)} sn`)}`);
  console.log(failures ? c.red(`\n${failures} kontrol başarısız!\n`) : c.green('\n✓ Tüm kontroller geçti.\n'));
  process.exit(failures ? 1 : 0);
}

async function cmdSeed() {
  const d = need();
  const op = operatorAccount();
  const w = walletFor(op);
  const mid = Number(process.argv[3] || 5000); // 50,00 tTRY
  const amt = parseEther('0.02');
  console.log(c.bold(`\nDeftere başlangıç emirleri (orta fiyat ${(mid / 100).toFixed(2)})\n`));
  const [monFree] = await read(d, 'balancesOf', [op.address]);
  if (monFree < parseEther('0.1')) await send(w, d, 'deposit', [], parseEther('0.12'));
  try {
    await send(w, d, 'faucet');
  } catch {
    console.log(c.dim('faucet bekleme süresinde, mevcut tTRY kullanılacak'));
  }
  for (let i = 1; i <= 5; i++) {
    const ask = mid + 25 + i * 25;
    const bid = mid - 25 - i * 25;
    const r1 = await send(w, d, 'place', [false, ask, amt]);
    const r2 = await send(w, d, 'place', [true, bid, amt]);
    console.log(`  satış ${(ask / 100).toFixed(2)}  ·  alış ${(bid / 100).toFixed(2)}  ${c.dim(`${secs(r1.ms)} / ${secs(r2.ms)} sn`)}`);
  }
  console.log(c.green('\n✓ Defter hazır.\n'));
}

async function cmdStats() {
  const d = need();
  const [orders, trades, volume, open] = await read(d, 'stats');
  console.log(`\nSözleşme: ${d.address}`);
  console.log(`Emir: ${orders}  İşlem: ${trades}  Hacim: ${fmt(volume)} MON  Açık emir: ${open}\n`);
}

async function cmdFund(to, amount = '0.3') {
  if (!isAddress(to || '')) {
    console.log(c.red('Kullanım: node scripts/pazar.mjs fund 0x... 0.3'));
    process.exit(1);
  }
  const t = Date.now();
  const hash = await walletFor(operatorAccount()).sendTransaction({ to, value: parseEther(String(amount)) });
  const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (r.status !== 'success') throw new Error(`Gönderim geri çevrildi: ${EXPLORER}/tx/${hash}`);
  console.log(c.green(`✓ ${amount} MON gönderildi (${secs(Date.now() - t)} sn)`));
}

async function cmdDiag() {
  const d = need();
  const { createWalletClient, http, encodeFunctionData } = await import('viem');
  const X = privateKeyToAccount(generatePrivateKey());
  const op = walletFor(operatorAccount());
  const h = await op.sendTransaction({ to: X.address, value: parseEther('1') });
  const r = await publicClient.waitForTransactionReceipt({ hash: h, pollingInterval: 250 });
  console.log(`fonlama 1 MON: ${r.status}  ${X.address}`);
  await sleep(3000);
  const rpcs = ['https://testnet-rpc.monad.xyz', 'https://monad-testnet.drpc.org', 'https://rpc.ankr.com/monad_testnet'];
  const tests = [
    ['faucet (değersiz)', 'faucet', undefined],
    ['deposit 0,02', 'deposit', parseEther('0.02')],
    ['deposit 0,2', 'deposit', parseEther('0.2')],
  ];
  for (const [label, fn, value] of tests) {
    for (const url of rpcs) {
      const w = createWalletClient({ account: X, chain: monadTestnet, transport: http(url) });
      try {
        const req = await w.prepareTransactionRequest({ to: d.address, data: encodeFunctionData({ abi: d.abi, functionName: fn }), ...(value ? { value } : {}) });
        const hash = await w.sendTransaction(req);
        const rr = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
        console.log(c.green(`✓ ${label} @ ${url.split('/')[2]}: ${rr.status} (gas ${req.gas}, maxFee ${req.maxFeePerGas})`));
        await sleep(2500);
        break;
      } catch (e) {
        console.log(c.dim(`✗ ${label} @ ${url.split('/')[2]}: ${(e.details || e.shortMessage || e.message).split('\n')[0]}`));
      }
    }
  }
  const [mf] = await read(d, 'balancesOf', [X.address]);
  console.log(`\nborsada serbest MON: ${formatEther(mf)}, cüzdan: ${formatEther(await publicClient.getBalance({ address: X.address }))}`);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  wallet: cmdWallet,
  compile: async () => compile(),
  deploy: cmdDeploy,
  selftest: cmdSelftest,
  seed: cmdSeed,
  stats: cmdStats,
  fund: () => cmdFund(args[0], args[1]),
  diag: cmdDiag,
};
if (!commands[cmd]) {
  console.log('Komutlar: wallet | compile | deploy | selftest | seed [ortaFiyatKuruş] | stats | fund <adres> [MON]');
  process.exit(1);
}
commands[cmd]().catch((e) => {
  console.log(c.red('\nHata:'), e.shortMessage || e.message);
  if (e.details) console.log(c.dim(`Ayrıntı: ${e.details}`));
  process.exit(1);
});
