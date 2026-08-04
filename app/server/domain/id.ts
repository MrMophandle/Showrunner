import { randomUUID } from 'node:crypto'

/**
 * Ids are readable on sight — `ep_9f2c1a4b7d3e` tells you what you are looking at in a
 * log line, a SQL console, or a file under the library volume.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}
