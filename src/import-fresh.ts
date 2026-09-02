import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Import a user module, seeing edits made since the last import.
 *
 * Node caches an ES module by URL for the life of the process. The MCP server
 * is long-lived, so a step or drive file edited between two calls would keep
 * running its first version. The file's mtime and size in the query string
 * make an edited file a new URL and an unchanged one the same URL.
 */
export async function importFresh<T = unknown>(file: string): Promise<T> {
  const abs = path.resolve(file);
  const { mtimeMs, size } = await stat(abs);
  const url = pathToFileURL(abs);
  url.searchParams.set('v', `${mtimeMs}-${size}`);
  return (await import(url.href)) as T;
}
