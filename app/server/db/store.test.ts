import { describe, expect, it } from 'vitest'
import { openStore } from './store.ts'

describe('the store — the one seam onto SQLite', () => {
  it('enforces foreign keys, so a dangling reference is refused at the door', () => {
    const store = openStore(':memory:')
    try {
      store.exec(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
      `)

      expect(() => store.run('INSERT INTO child VALUES (?, ?)', 'c1', 'nobody')).toThrow(
        /FOREIGN KEY/i,
      )
    } finally {
      store.close()
    }
  })

  it('hands back ordinary objects, not the driver’s null-prototype rows', () => {
    const store = openStore(':memory:')
    try {
      store.exec("CREATE TABLE t (a TEXT, b INTEGER); INSERT INTO t VALUES ('x', 1)")

      const row = store.get<{ a: string; b: number }>('SELECT * FROM t WHERE a = ?', 'x')

      expect(row).toEqual({ a: 'x', b: 1 })
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    } finally {
      store.close()
    }
  })

  it('rolls the whole transaction back when the body throws', () => {
    const store = openStore(':memory:')
    try {
      store.exec('CREATE TABLE t (a TEXT)')

      expect(() =>
        store.transaction(() => {
          store.run('INSERT INTO t VALUES (?)', 'written')
          throw new Error('the step failed halfway')
        }),
      ).toThrow('the step failed halfway')

      expect(store.all('SELECT * FROM t')).toEqual([])
    } finally {
      store.close()
    }
  })
})
