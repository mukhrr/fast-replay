import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_WORKFLOW, MCP_CONFIG_SNIPPET } from '../src/agent-notes.js';
import { GITIGNORE_BLOCK, initProject } from '../src/init.js';

/**
 * repro init draws the line through .repros/: steps and config are committed,
 * repros and sessions are not. It is idempotent and prints every change.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'replay-init-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('repro init', () => {
  it('writes the ignore rules, the default config and the steps dir', async () => {
    const { changes } = await initProject(root);
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    for (const line of GITIGNORE_BLOCK) expect(ignore.split('\n')).toContain(line);
    expect(ignore.endsWith('\n')).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, '.repros/config.json'), 'utf8'))).toEqual({
      extractThreshold: 4,
    });
    expect(existsSync(path.join(root, '.repros/steps'))).toBe(true);
    expect(changes.join('\n')).toMatch(/\.gitignore: added 3 rules/);
    expect(changes.join('\n')).toMatch(/wrote \.repros\/config\.json/);
  });

  it('runs twice without duplicating anything', async () => {
    await initProject(root);
    const before = await readFile(path.join(root, '.gitignore'), 'utf8');
    await writeFile(path.join(root, '.repros/config.json'), '{ "extractThreshold": 7 }', 'utf8');
    const { changes } = await initProject(root);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(before);
    expect(await readFile(path.join(root, '.repros/config.json'), 'utf8')).toBe('{ "extractThreshold": 7 }');
    expect(changes.join('\n')).toMatch(/already ignores/);
    expect(changes.join('\n')).toMatch(/already exists/);
  });

  it('appends to an existing .gitignore without touching its content', async () => {
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist', 'utf8');
    await initProject(root);
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(ignore.startsWith('node_modules/\ndist\n')).toBe(true);
    expect(ignore).toContain(`\n${GITIGNORE_BLOCK.join('\n')}\n`);
  });

  it('carries the workflow an agent needs, and the same text the server sends', () => {
    for (const tool of ['repro_steps', 'repro_record', 'repro_run', 'repro_extract', 'repro_delete']) {
      expect(AGENT_WORKFLOW).toContain(tool);
    }
    expect(AGENT_WORKFLOW).toContain('expect_fixed');
    expect(AGENT_WORKFLOW).toContain('COULD NOT VERIFY');
    expect(JSON.parse(MCP_CONFIG_SNIPPET)).toEqual({
      mcpServers: { replay: { command: 'npx', args: ['repro-mcp'] } },
    });
  });
});
