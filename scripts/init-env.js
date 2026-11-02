import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

let template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
for (const key of ['ADMIN_TOKEN', 'ONEBOT_SECRET', 'ONEBOT_TOKEN', 'WEBUI_TOKEN']) {
  template = template.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${randomBytes(32).toString('hex')}`);
}
template = template.replace(/^ALLOWED_USERS=.*$/m, 'ALLOWED_USERS=');
try {
  await writeFile(new URL('../.env', import.meta.url), template, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with random secrets. Edit ALLOWED_USERS and model settings before starting.');
} catch (error) {
  if (error.code === 'EEXIST') { console.error('.env already exists; no changes made.'); process.exitCode = 1; }
  else throw error;
}
