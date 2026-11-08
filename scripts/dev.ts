// Starts the API server and the UI together.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

const PORTS = [4680, 5173];

const isBusy = (port: number) => new Promise<boolean>((resolve) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

const busy = [];
for (const port of PORTS) if (await isBusy(port)) busy.push(port);
if (busy.length) {
  console.error(`Port ${busy.join(' and ')} is in use, is another dev server already running?`);
  console.error(process.platform === 'win32'
    ? `Find out who is using it: netstat -ano | findstr ":${busy[0]}"`
    : `Find out who is using it: lsof -i :${busy[0]}`);
  process.exit(1);
}

const procs: ChildProcess[] = [
  spawn(process.execPath, ['--watch', 'packages/server/src/main.ts'], { stdio: 'inherit' }),
  spawn('npm run dev -w @mwo/web', { stdio: 'inherit', shell: true }),
];

function kill(p: ChildProcess) {
  // On Windows, kill() only ends the shell, not Vite behind it.
  if (process.platform === 'win32' && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else p.kill();
}
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  procs.forEach(kill);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
