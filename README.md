# Pazar: tamamen zincir üstü borsa

**Pazar**, MON / tTRY paritesi için bir limit emir defteri. Emirlerin kaydı, eşleştirilmesi ve takası Monad testnet'indeki tek bir akıllı sözleşmenin içinde yapılıyor. Arada sunucu, aracı ya da merkezi bir eşleştirme motoru yok.

> Monad Blitz Ankara, 24 Ekim 2026

**Sözleşme (Monad testnet):** [`0x83b295c3cfdac57ff8eaec6be9e0a97acca6dfba`](https://testnet.monadscan.com/address/0x83b295c3cfdac57ff8eaec6be9e0a97acca6dfba)

## Neden Monad?

Zincir üstü emir defterleri Ethereum'da pratik değil. Her emir, iptal ve eşleşme birer işlem; 12 saniyelik bloklar ve yüksek ücretler yüzünden borsalar ya eşleştirmeyi zincir dışına taşıyor ya da AMM modeline geçiyor. Monad'ın yaklaşık 0,4 saniyelik blokları ve yüksek işlem kapasitesi sayesinde Pazar'da emir verme, eşleşme ve iptalin tamamı zincirde gerçekleşiyor ve kullanıcı sonucu bir saniyenin altında görüyor. Arayüzdeki **"Ort. onay"** göstergesi ve alttaki işlem çubuğu her işlemin gerçek onay süresini canlı olarak gösteriyor.

## Neler var

- **Zincir üstü eşleştirme motoru** (`contracts/Pazar.sol`):
  - Fiyat-zaman önceliğiyle eşleştirme; işlem her zaman bekleyen emrin fiyatından gerçekleşiyor.
  - Kısmi eşleşme ve iptal destekleniyor.
  - Bakiyeler sözleşmenin içinde tutuluyor: MON yatırma/çekme ve test lirası tTRY faucet'i.
- **Canlı web arayüzü** (`public/`):
  - Emir defteri (derinlik çubukları; bir fiyata tıklayınca form doluyor), fiyat grafiği, son işlemler, açık emirler.
  - Bekleyen emrin karşı taraftan eşleşince anlık bildirim veriyor.
- **Türkçe emir asistanı:** "piyasadan 0,02 MON al" ya da "48 liradan 0,01 sat" gibi cümleleri Claude limit emrine çeviriyor. Emir, kullanıcı kontrol edip onayladıktan sonra gönderiliyor.
- **Demo cüzdanları:** `?kim=ayse` ve `?kim=mehmet` ile iki ayrı tarayıcı penceresinde iki farklı kullanıcı. Cüzdanlar tarayıcıda oluşturuluyor; sunucu ilk test MON'unu gönderiyor.

## Mimari

```
Tarayıcı (viem) ──imzalı işlem──▶ Monad testnet ─▶ Pazar.sol
      ▲                                            (defter + eşleştirme + takas)
      └──── her saniye book() / recentTrades() / balancesOf() okuması

server.mjs:  statik dosyalar · /api/config · /api/drip (test MON) · /api/ai/order (Claude)
```

Sunucu yalnızca kolaylık sağlıyor: arayüzü sunuyor, test MON'u dağıtıyor ve Türkçe cümleyi emre çeviriyor. Emirler ve bakiyeler sunucuda değil, sözleşmede duruyor.

### Sözleşme ayrıntıları

| | |
|---|---|
| Fiyat birimi | kuruş (1 tTRY = 100) |
| En küçük miktar / adım | 0,001 MON / 0,0001 MON |
| Defterdeki en fazla açık emir | 120 |
| Bir emirde en fazla eşleşme | 12 (kalan miktar deftere yazılır) |
| İşlem geçmişi | son 50 işlem, halka tampon |

Fonksiyonlar: `deposit`, `withdraw`, `faucet`, `place(isBuy, price, amount)`, `cancel(id)`, `book()`, `recentTrades(n)`, `balancesOf(user)`, `stats()`.

## Çalıştırma

Node.js 20+ gerekiyor.

```bash
npm install
node scripts/pazar.mjs wallet     # operatör cüzdanı (yoksa oluşturur); faucet.monad.xyz'den MON al
node scripts/pazar.mjs deploy     # derle + Monad testnet'e yükle → deployment.json
node scripts/pazar.mjs selftest   # iki yeni cüzdanla zincir üstü uçtan uca test
node scripts/pazar.mjs seed       # deftere başlangıç alış/satış emirleri
node server.mjs                   # http://localhost:3000/?kim=ayse  ve  ?kim=mehmet
```

Türkçe emir asistanı için `.env` dosyasına `ANTHROPIC_API_KEY=...` satırını ekle. Anahtar olmadan da her şey çalışır, yalnızca asistan kapalı kalır.

### Canlıya alma (Render)

Depoda `render.yaml` var. Render'da **New → Blueprint** ile bu repoyu seç, iki gizli değişkeni gir:

- `OPERATOR_PRIVATE_KEY`: demo cüzdanlarına test MON'u gönderen operatör cüzdanının anahtarı
- `ANTHROPIC_API_KEY`: Türkçe emir asistanı için (boş bırakılabilir)

Herkese açık sunucuda operatör cüzdanı ve API kredisi korunsun diye musluk saatte 6 cüzdanla, asistan da IP başına 10 dakikada 12 istekle sınırlı.

### Monad'a özgü notlar

- Monad, bakiye kontrolünü birkaç blok gecikmeli durum üzerinden yapıyor. Yeni fonlanan bir cüzdanın ilk işlemi kısa süre "insufficient balance" alabiliyor; betik ve arayüz bu durumda işlemi otomatik olarak yeniden deniyor.
- *Reserve balance* kuralı: bakiyesi 10 MON'un altında olan bir cüzdan, son birkaç blokta işlem yaptıysa değer transferiyle bakiyesini düşüremez. Operatör cüzdanının art arda gönderimleri bu yüzden aralıklı yapılıyor.

## Güvenlik ve kapsam

Bu proje, hackathon için testnet'te çalışan bir prototip; denetlenmemiştir. MON ve tTRY'nin parasal değeri yoktur. Demo cüzdanlarının anahtarları tarayıcının yerel deposunda tutuluyor ve yalnızca test amaçlı.

---

### English summary

Pazar is a fully on-chain limit order book exchange (MON / test-TRY) on Monad testnet. Order placement, price-time-priority matching, partial fills, cancellation and settlement all happen inside one Solidity contract. A web UI shows the live book, chart and trades with real confirmation times, and a Claude-powered assistant turns Turkish sentences into limit orders that the user reviews and confirms before sending. Monad's sub-second blocks are what make a fully on-chain order book usable.
