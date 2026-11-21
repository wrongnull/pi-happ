import { runWatchdog } from './watchdog.mjs';

const [pid, identity, directory] = process.argv.slice(2);
if (!/^\d+$/.test(pid || '') || Number(pid) <= 1 || !/^\d+$/.test(identity || '') || !directory) {
  process.exit(1);
}
try { await runWatchdog(Number(pid), identity, directory); }
catch { process.exitCode = 1; }
