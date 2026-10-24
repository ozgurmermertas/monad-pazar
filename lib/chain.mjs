// Ortak Monad testnet ayarları ve yardımcılar (betik + sunucu)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RPC_URL = process.env.MONAD_RPC || 'https://testnet-rpc.monad.xyz';
export const EXPLORER = 'https://testnet.monadscan.com';
export const FAUCET_URL = 'https://faucet.monad.xyz';
export const DEPLOYMENT_FILE = path.join(ROOT, 'deployment.json');
const KEY_FILE = path.join(ROOT, '.operator-key.json');

export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Monadscan', url: EXPLORER } },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL),
  pollingInterval: 300,
});

export const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

/** Operatör cüzdanı: sözleşmeyi yükler, demo cüzdanlarına MON damlatır. Sadece testnet! */
export function operatorAccount() {
  // Sunucuda (Render vb.) anahtar ortam değişkeninden gelir
  const envKey = process.env.OPERATOR_PRIVATE_KEY?.trim();
  if (envKey) return privateKeyToAccount(envKey.startsWith('0x') ? envKey : `0x${envKey}`);
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, JSON.stringify({ privateKey: generatePrivateKey() }, null, 2));
    console.log(c.yellow('Yeni operatör cüzdanı oluşturuldu: .operator-key.json (paylaşma!)'));
  }
  return privateKeyToAccount(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).privateKey);
}

export function walletFor(account) {
  return createWalletClient({ account, chain: monadTestnet, transport: http(RPC_URL) });
}

export function readDeployment() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) return null;
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

/** .env dosyasını (KEY=VALUE) okur */
export function loadEnv() {
  const file = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...env, ...process.env };
}

export const secs = (ms) => (ms / 1000).toFixed(2);
