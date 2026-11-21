// Linux sidecar: stdin is a private pipe owned only by Pi. EOF means parent death.
import { readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return fields[19]; // starttime: /proc stat field 22, after pid and comm
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
    throw error;
  }
}

export async function runWatchdog(pid, identity, directory) {
  let parentGone = false;
  process.stdin.on('end', () => { parentGone = true; });
  process.stdin.on('error', () => { parentGone = true; });
  process.stdin.resume();
  process.stdout.on('error', () => { parentGone = true; });
  // Signals must trigger cleanup, not terminate the watchdog prematurely.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { parentGone = true; });
  }
  process.stdout.write('ready\n');
  while (await processIdentity(pid) === identity) {
    if (!parentGone) { await delay(100); continue; }
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 2000;
    while (await processIdentity(pid) === identity && Date.now() < deadline) await delay(50);
    // Checking starttime prevents killing an unrelated process after PID reuse.
    if (await processIdentity(pid) === identity) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    while (await processIdentity(pid) === identity) await delay(50);
    break;
  }
  await rm(directory, { recursive: true, force: true });
  process.stdin.destroy();
}
