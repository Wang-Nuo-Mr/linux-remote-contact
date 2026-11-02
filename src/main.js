import { loadConfig } from './config.js';
import { createApp } from './app.js';

try {
  const config = loadConfig();
  const app = await createApp(config);
  app.server.listen(config.port, config.host, () => console.log(`Linux Remote Contact listening on ${config.host}:${config.port}`));
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 300000);
    timer.unref();
    await app.close();
    clearTimeout(timer);
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
