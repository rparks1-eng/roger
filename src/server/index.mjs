import { createReaderServer } from './http.mjs';
import { createMemoryStore } from './memory.mjs';
import { loadOwnerCanvas } from './owner-canvas.mjs';
const port = Number(process.env.READER_PORT ?? 3847);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Choose a local port from 1024 to 65535.');
const server = createReaderServer({
  configuredCanvas: await loadOwnerCanvas(),
  memoryStore: createMemoryStore(),
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Atlas Reader class project: http://127.0.0.1:${port}`),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
