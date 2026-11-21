import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './watchdog.mjs';

export async function watchChild(child, directory) {
  if (process.platform !== 'linux') throw new Error('Xray watchdog currently requires Linux');
  const identity = await processIdentity(child.pid);
  if (!identity) throw new Error('Xray exited before watchdog startup');
  const watcher = spawn(process.execPath, [fileURLToPath(new URL('./watchdog-runner.mjs', import.meta.url)),
    String(child.pid), identity, directory], { stdio: ['pipe', 'pipe', 'ignore'] });
  // Broken control pipe is reported by watcher exit handling, not an uncaught EPIPE.
  watcher.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Watchdog startup timed out')), 5000);
      const onError = () => finish(new Error('Cannot start Xray watchdog'));
      const onClose = () => finish(new Error('Xray watchdog exited before readiness'));
      const onData = () => finish();
      const finish = (error) => {
        clearTimeout(timer);
        watcher.off('error', onError); watcher.off('close', onClose); watcher.stdout.off('data', onData);
        if (error) reject(error); else resolve();
      };
      watcher.once('error', onError); watcher.once('close', onClose); watcher.stdout.once('data', onData);
    });
  } catch (error) { watcher.stdin.destroy(); throw error; }
  return watcher;
}
