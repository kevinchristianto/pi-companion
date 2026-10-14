// Cross-platform, explicit development fixture. Build mode always removes the fixture.
process.env.VITE_COMPANION_REVIEW = '1';
const { createServer } = await import('vite');
const server = await createServer({ server: { host: '127.0.0.1', port: 1420, strictPort: true } });
await server.listen();
server.printUrls();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
