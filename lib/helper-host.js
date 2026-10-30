/** Own one helper process. Repeated restart requests coalesce until that child exits. */
export function createHelperHost({
  spawnChild, onStart = () => {}, onLine = () => {}, onError = () => {}, onStderr = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, healthyMs = 30_000, maxRestarts = 3,
}) {
  let child = null, restartTimer = null, healthTimer = null, stopped = false, attempts = 0;
  const cancelHealth = () => { if (healthTimer !== null) clearTimer(healthTimer); healthTimer = null; };
  function scheduleRestart() {
    if (stopped || child !== null || restartTimer !== null || attempts >= maxRestarts) return;
    const delay = 1000 * 2 ** attempts++;
    restartTimer = setTimer(() => { restartTimer = null; start(); }, delay);
    restartTimer?.unref?.();
  }
  function start() {
    if (stopped || child !== null || restartTimer !== null) return child;
    let current;
    try { current = spawnChild(); } catch (error) { onError(error); scheduleRestart(); return null; }
    child = current;
    let buffer = '', stopping = false;
    const finish = () => {
      if (child !== current) return;
      child = null; cancelHealth(); scheduleRestart();
    };
    const restart = error => {
      if (child !== current || stopped || stopping) return;
      stopping = true;
      if (error) onError(error);
      cancelHealth();
      // Do not spawn a replacement until the existing child is gone.
      try { current.kill(); } catch (error) { onError(error); }
    };
    current.once('exit', finish);
    current.once('error', error => {
      if (child !== current) return;
      onError(error);
      if (!current.pid) finish(); else restart();
    });
    current.stdin?.on('error', restart);
    current.stdout?.setEncoding('utf8');
    current.stdout?.on('data', chunk => {
      if (child !== current || stopped) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1_500_000) { restart(new Error('helper frame exceeds limit')); return; }
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          if (JSON.parse(line).type === 'ready' && healthTimer === null) {
            healthTimer = setTimer(() => {
              healthTimer = null;
              if (child === current && !stopped) attempts = 0;
            }, healthyMs);
            healthTimer?.unref?.();
          }
        } catch {}
        onLine(line);
      }
    });
    current.stderr?.setEncoding('utf8');
    current.stderr?.on('data', chunk => { if (child === current && !stopped) onStderr(chunk); });
    current.restart = restart;
    onStart(current);
    return current;
  }
  function send(json) {
    const current = child;
    if (stopped || !current?.stdin || current.stdin.destroyed || current.stdin.writableEnded) return false;
    try {
      current.stdin.write(json + '\n', error => { if (error) current.restart(error); });
      return true;
    } catch (error) { current.restart(error); return false; }
  }
  function stop() {
    stopped = true; cancelHealth();
    if (restartTimer !== null) clearTimer(restartTimer);
    restartTimer = null;
    const current = child; child = null;
    if (!current) return;
    try { current.stdin?.end(JSON.stringify({ type: 'shutdown' }) + '\n'); } catch {}
    try { current.kill(); } catch {}
  }
  return { start, send, stop, get child() { return child; } };
}
