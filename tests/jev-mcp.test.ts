import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReplayServer, reproPaths } from '../src/api.js';
import type { ChoiceAnswer, JevClient } from '../src/jev/client.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

let server: DemoServer;
let root: string;
const saved = { key: process.env.TYPESAFE_API_KEY, xdg: process.env.XDG_CONFIG_HOME };

async function connect(jev?: JevClient) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const replay = await createReplayServer(root, jev ? { jev } : {});
  await Promise.all([replay.server.connect(serverTransport), client.connect(clientTransport)]);
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'repro_record', arguments: args }) as Promise<ToolResult>;
  return { client, replay, call };
}
const text = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  server = await startDemoServer(5448);
  root = await mkdtemp(path.join(tmpdir(), 'replay-jev-mcp-'));
  delete process.env.TYPESAFE_API_KEY;
  process.env.XDG_CONFIG_HOME = root;
}, 60_000);
afterAll(async () => {
  if (saved.key !== undefined) process.env.TYPESAFE_API_KEY = saved.key;
  if (saved.xdg !== undefined) process.env.XDG_CONFIG_HOME = saved.xdg;
  else delete process.env.XDG_CONFIG_HOME;
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('repro_record with a goal', () => {
  it('says in the instructions whether a Jev key is set', async () => {
    const { client, replay } = await connect();
    expect(client.getInstructions()).toMatch(/Jev: no key set/);
    await replay.dispose();
    await client.close();
  });

  it('refuses a goal without a key', async () => {
    const { client, replay, call } = await connect();
    const result = await call({ name: 'g1', url: server.baseUrl, goal: 'x', until: 'h1' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('--goal needs a TypeSafe key');
    await replay.dispose();
    await client.close();
  });

  it('refuses neither or both of drive and goal', async () => {
    const { client, replay, call } = await connect();
    expect(text(await call({ name: 'g2', url: server.baseUrl }))).toMatch(/exactly one of drive or goal/);
    expect(text(await call({ name: 'g2', url: server.baseUrl, drive: 'a.mjs', goal: 'x', until: 'h1' }))).toMatch(/exactly one of drive or goal/);
    expect(text(await call({ name: 'g2', url: server.baseUrl, goal: 'x' }))).toMatch(/goal needs until/);
    await replay.dispose();
    await client.close();
  });

  it('records with an injected client and reports the path', async () => {
    await fetch(`${server.baseUrl}/api/reset`, { method: 'POST' });
    const picks = ['click button "Reports"'];
    const jev: JevClient = {
      async choice(_s, _i, criteria): Promise<ChoiceAnswer> {
        const want = picks.shift() ?? 'none';
        const key = Object.keys(criteria).find((k) => criteria[k] === want) ?? 'none';
        return { choice: key, confidence: 0.9, probabilities: { [key]: 0.9 } };
      },
    };
    const { client, replay, call } = await connect(jev);
    const result = await call({ name: 'g3', url: server.baseUrl, goal: 'Open reports', until: 'url=/reports' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/Path: click button "Reports"/);
    expect(result.structuredContent?.goalPath).toEqual(['click button "Reports"']);
    expect(existsSync(reproPaths('g3', root).ir)).toBe(true);
    await replay.dispose();
    await client.close();
  });

  it('writes nothing when the goal is not reached', async () => {
    const jev: JevClient = { async choice() { return { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } }; } };
    const { client, replay, call } = await connect(jev);
    const result = await call({ name: 'g4', url: server.baseUrl, goal: 'Change password', until: 'text=Done' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Jev found no action toward the goal/);
    expect(existsSync(reproPaths('g4', root).ir)).toBe(false);
    await replay.dispose();
    await client.close();
  });

  it('refuses setup naming a step that does not exist', async () => {
    const jev: JevClient = { async choice() { return { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } }; } };
    const { client, replay, call } = await connect(jev);
    const result = await call({
      name: 'g5',
      url: server.baseUrl,
      goal: 'Open reports',
      until: 'url=/reports',
      setup: [{ step: 'signed-in' }],
    });
    expect(result.isError).toBe(true);
    // No .repros/steps directory in this scratch root, so record() rejects
    // before opening a browser — this is StepError's own message, unchanged.
    expect(text(result)).toMatch(/Shared step "signed-in" is not defined/);
    expect(existsSync(reproPaths('g5', root).ir)).toBe(false);
    await replay.dispose();
    await client.close();
  });

  it('refuses setup together with drive', async () => {
    const { client, replay, call } = await connect();
    const result = await call({
      name: 'g6',
      url: server.baseUrl,
      drive: 'does-not-matter.mjs',
      setup: [{ step: 'signed-in' }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/setup is for goal/);
    await replay.dispose();
    await client.close();
  });
});
