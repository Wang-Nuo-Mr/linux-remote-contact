import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Minimal environment: configured tasks do not inherit bot/model/admin credentials.
export function childEnv() {
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'SystemRoot'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
}

export function runProcess(command, args, { cwd, timeout = 30000, input, env = childEnv(), limit = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, timedOut = false, truncated = false;
    const kill = () => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    const collect = chunk => {
      const remaining = limit - bytes;
      output += chunk.subarray(0, Math.max(0, remaining)).toString('utf8');
      bytes += chunk.length;
      if (bytes > limit) { truncated = true; kill(); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output, timedOut, truncated }); });
    child.stdin.end(input || '');
  });
}

export async function loadTasks(path) {
  const tasks = JSON.parse(await readFile(path, 'utf8'));
  if (!tasks || Array.isArray(tasks) || typeof tasks !== 'object') throw new Error('tasks.json must be an object');
  for (const [name, task] of Object.entries(tasks)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name) || typeof task.command !== 'string' || !task.command || !Array.isArray(task.args) || task.args.some(x => typeof x !== 'string') || !Number.isInteger(task.timeoutMs) || task.timeoutMs < 100 || task.timeoutMs > 300000) throw new Error(`Invalid task: ${name}`);
  }
  return tasks;
}
