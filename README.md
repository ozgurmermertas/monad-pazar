# Pazar

Monad üzerinde tamamen zincir üstü çalışan bir MON/tTRY borsası. Emirler, eşleştirme ve takas tek bir akıllı sözleşmede; arada şirket ya da gizli defter yok.

Monad Blitz Ankara · 24 Ekim 2026

**Canlı demo:** [monad-pazar.onrender.com](https://monad-pazar.onrender.com/?kim=ayse). İki kullanıcıyla denemek için iki pencerede [`?kim=ayse`](https://monad-pazar.onrender.com/?kim=ayse) ve [`?kim=mehmet`](https://monad-pazar.onrender.com/?kim=mehmet) aç.

**Sözleşme:** [`0x83b2…dfba`](https://testnet.monadscan.com/address/0x83b295c3cfdac57ff8eaec6be9e0a97acca6dfba) (Monad testnet)

## Neden Monad?

Zincir üstü emir defteri Ethereum'da kullanılamıyor: her emir bir işlem ve bloklar 12 saniye. Monad'da işlemler yarım saniyenin altında onaylandığı için borsa merkezi bir borsa kadar akıcı, ama paran ve defter herkesin denetleyebildiği bir sözleşmede.

## Özellikler

- Fiyat-zaman öncelikli eşleştirme, kısmi eşleşme ve iptal; hepsi sözleşmede
- Canlı emir defteri, grafik, son işlemler ve her işlemin onay süresi
- Türkçe emir asistanı (Claude): "piyasadan 0,02 MON al" yaz, emri onayla
- Alt şeritte canlı Monad blokları; senin işlemlerinin girdiği bloklar mor

## Çalıştır

```bash
npm install
node scripts/pazar.mjs deploy   # sözleşmeyi Monad testnet'e yükle
node scripts/pazar.mjs seed     # deftere başlangıç emirleri
node server.mjs                 # localhost:3000/?kim=ayse ve ?kim=mehmet
```

Türkçe asistan için `.env` dosyasına `ANTHROPIC_API_KEY` ekle.

Testnet prototipidir, denetlenmemiştir.
