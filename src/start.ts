import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One-command full stack: runs the scanner (src/index.ts) and the read-only
 * dashboard (src/server.ts) together, so `npm start` launches everything.
 * Ctrl-C stops both.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const tsx = join(__dirname, "..", "node_modules", ".bin", "tsx");

const C = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", dim: "\x1b[2m" };

function run(name: string, script: string, color: string, extraArgs: string[]): ChildProcess {
  const child = spawn(tsx, [join(__dirname, script), ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
  const tag = `${color}[${name}]${C.reset} `;
  const pipe = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) process.stdout.write(tag + line + "\n");
  };
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);
  return child;
}

// Pass through any CLI flags to the scanner only.
const scannerArgs = process.argv.slice(2);

console.log(`${C.dim}Shitcoin full stack — scanner + web. Ctrl-C to stop both.${C.reset}\n`);
const bot = run("bot", "index.ts", C.green, scannerArgs);
const dash = run("web", "server.ts", C.cyan, []);

console.log(`${C.cyan}→ web (landing · login · console) at http://localhost:4317${C.reset}\n`);

const shutdown = () => {
  bot.kill("SIGINT");
  dash.kill("SIGINT");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// If either child dies, bring down the other so the stack fails loudly, not half-up.
bot.on("exit", (code) => { console.log(`${C.green}[bot] exited (${code})${C.reset}`); shutdown(); });
dash.on("exit", (code) => { console.log(`${C.cyan}[dashboard] exited (${code})${C.reset}`); shutdown(); });
