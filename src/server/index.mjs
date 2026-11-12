import { createReaderServer, startRecordingDemo } from './http.mjs';
import { createMemoryStore } from './memory.mjs';
import { loadOwnerCanvas } from './owner-canvas.mjs';
import { readCanvasOAuthConfig } from './canvas-oauth.mjs';
if (process.argv.includes('--demo')) {
  const demo = await startRecordingDemo();
  console.log(`Roger Demo mode: ${demo.url}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void demo.close());
} else {
  const port = Number(process.env.READER_PORT ?? 3847);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Choose a local port from 1024 to 65535.');
  const server = createReaderServer({
    configuredCanvas: await loadOwnerCanvas(),
    canvasOAuthConfig: readCanvasOAuthConfig(),
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
}
