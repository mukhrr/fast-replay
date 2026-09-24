import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { record } from '../src/api.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

// Costs real API calls, so it runs only when a key is in the environment.
describe.skipIf(!process.env.TYPESAFE_API_KEY)('Jev against the real API', () => {
  let server: DemoServer;
  let root: string;
  beforeAll(async () => {
    server = await startDemoServer(5448);
    root = await mkdtemp(path.join(tmpdir(), 'replay-jev-live-'));
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('adds a sensor by goal', async () => {
    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const result = await record({
      name: 'live-add',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: { goal: 'Add a new sensor named Boiler inlet', until: 'text=Boiler inlet', inputs: { 'New sensor name': 'Boiler inlet' } },
    });
    expect(result.goalPath).toContain('click button "Add sensor"');
  });

  it('generates a report by goal', async () => {
    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const result = await record({
      name: 'live-report',
      baseUrl: server.baseUrl,
      root,
      headless: true,
      goal: {
        goal: 'Generate a report titled Weekly rollup for Sensor 3',
        until: '[data-testid="report-result"]',
        inputs: { 'Report title': 'Weekly rollup', Sensor: 'Sensor 3' },
      },
    });
    expect(result.goalPath).toContain('click button "Generate report"');
  });
});
