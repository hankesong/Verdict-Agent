import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const [fileArg, network = "bot-testnet"] = process.argv.slice(2);
if (!fileArg || !["bot-testnet", "bot-mainnet"].includes(network))
  throw new Error("Usage: npm run wallet:configure-network -- .local/<dir>/local-one.json bot-testnet|bot-mainnet");
const root = process.cwd();
const file = resolve(root, fileArg);
const local = resolve(root, ".local");
const rel = relative(local, file);
if (!existsSync(file) || rel.startsWith("..") || isAbsolute(rel))
  throw new Error("Config must be an existing file inside .local");
const config = JSON.parse(readFileSync(file, "utf8"));
const mainnet = network === "bot-mainnet";
config.wallet = {
  networks: [{
    chainId: mainnet ? "0x2a5" : "0x3c8",
    nativeSymbol: mainnet ? "BOT" : "tBOT",
    name: mainnet ? "BOT Chain Mainnet" : "BOT Chain Testnet",
    rpcUrlEnv: "VERDICT_WALLET_RPC_URL",
    receiptEnabled: true,
    maxValueWei: "100000000000000",
    maxTotalFeeWei: "1000000000000000",
  }],
  rpcTimeoutMs: 8000,
  reviewTimeoutMs: 90000,
  permitTtlMs: 60000,
};
writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ configured: true, file, network: mainnet ? "BOT Chain Mainnet" : "BOT Chain Testnet", chainId: mainnet ? 677 : 968, rpcUrlEnv: "VERDICT_WALLET_RPC_URL", rpcUrl: mainnet ? "https://rpc.botchain.ai" : null, explorer: mainnet ? "https://scan.botchain.ai" : null, nativeSymbol: mainnet ? "BOT" : "tBOT", secretRead: false }));
