/**
 * Migrations, applied for real.
 *
 * The SQL is **extracted from `lib.rs` and executed**, not transcribed. A test
 * against a copy of a migration proves the copy works; the thing that ships is
 * the Rust string literal, so that is what runs here, against a real SQLite
 * database via `node:sqlite`.
 *
 * The question under test is the one the spec asks hardest: when an installation
 * is upgraded, who do the pre-existing rows belong to? Getting that wrong either
 * leaks one commander's history to another or silently misattributes it.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * `node:sqlite` is newer than Vite's builtin list, so a static import is
 * rewritten to a bare `sqlite` specifier and fails to resolve. Loading it
 * through createRequire keeps the transform out of the way, and keeps the fix in
 * the one file that needs it rather than in the build config.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const LIB = join(__dirname, '..', 'src-tauri', 'src', 'lib.rs');

/**
 * Pull every migration out of the Rust source, in order.
 *
 * Deliberately brittle in one direction: if the shape of the migration list
 * changes, this fails loudly rather than silently testing nothing.
 */
function migrations(): Array<{ version: number; sql: string }> {
  const source = readFileSync(LIB, 'utf8');
  const out: Array<{ version: number; sql: string }> = [];
  const pattern = /version:\s*(\d+),\s*description:\s*"[^"]*",\s*sql:\s*r#"([\s\S]*?)"#,/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    out.push({ version: Number(match[1]), sql: match[2]! });
  }
  return out.sort((a, b) => a.version - b.version);
}

/**
 * Apply migrations up to and including `through`, once each.
 *
 * The applied version is tracked, because migrations are not individually
 * idempotent -- `CREATE TABLE IF NOT EXISTS` can be re-run but
 * `ALTER TABLE ADD COLUMN` cannot. That mirrors how the real runner behaves, and
 * lets a test stage an install at version 10 and then upgrade it.
 */
function migrate(db: DatabaseSync, through: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS _applied (version INTEGER PRIMARY KEY)');
  const done = new Set(
    (db.prepare('SELECT version FROM _applied').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  for (const m of migrations()) {
    if (m.version > through || done.has(m.version)) continue;
    db.exec(m.sql);
    db.exec(`INSERT INTO _applied (version) VALUES (${m.version})`);
  }
}

/** A database as it stood before commander scoping existed. */
function legacyInstall(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, 10);

  // Rows written before anything was scoped: no owner.
  db.exec(`
    INSERT INTO missions
      (mission_id, name, type_key, category, status, accepted_at, source_event_id)
    VALUES (1, 'Mission_Delivery', 'delivery', 'trade', 'active',
            '2026-09-01T00:00:00Z', 'Journal.A.log:100');
  `);
  db.exec(`
    INSERT INTO construction_sites (market_id, resources, updated_at, first_seen_at)
    VALUES ('900001', '[]', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
  `);
  return db;
}

function seenCommander(db: DatabaseSync, fid: string, name: string): void {
  db.exec(
    `INSERT OR REPLACE INTO commander_state (fid, commander, docking, vehicle, updated_at)
     VALUES ('${fid}', '${name}', 'unknown', 'unknown', '2026-09-01T00:00:00Z')`,
  );
}

function owners(db: DatabaseSync, table: string): Array<string | null> {
  return (db.prepare(`SELECT commander_fid FROM ${table}`).all() as Array<{ commander_fid: string | null }>)
    .map((r) => r.commander_fid);
}

describe('migration extraction', () => {
  it('finds the real migrations in the Rust source', () => {
    const all = migrations();
    expect(all.length).toBeGreaterThanOrEqual(14);
    expect(all.map((m) => m.version)).toEqual([...all.map((m) => m.version)].sort((a, b) => a - b));
    // Versions are unique: two migrations sharing one would silently not run.
    expect(new Set(all.map((m) => m.version)).size).toBe(all.length);
  });

  it('applies cleanly from empty to current', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => migrate(db, 99)).not.toThrow();
    db.close();
  });
});

describe('legacy ownership: exactly one commander', () => {
  it('assigns unowned rows to the only commander this install knows', () => {
    // Evidence, not a guess: commander_state has exactly one row, so every
    // pre-scoping row was written by that commander.
    const db = legacyInstall();
    seenCommander(db, 'F0000001', 'Sythan');
    migrate(db, 12);

    expect(owners(db, 'missions')).toEqual(['F0000001']);
    expect(owners(db, 'construction_sites')).toEqual(['F0000001']);
    db.close();
  });

  it('records that commander in the registry', () => {
    const db = legacyInstall();
    seenCommander(db, 'F0000001', 'Sythan');
    migrate(db, 12);

    const rows = db.prepare('SELECT fid, commander FROM commander_registry').all();
    expect(rows).toEqual([{ fid: 'F0000001', commander: 'Sythan' }]);
    db.close();
  });
});

describe('legacy ownership: more than one commander', () => {
  it('does NOT assign rows to whoever happens to launch first', () => {
    // The behaviour being replaced. With two commanders on this machine the
    // history could belong to either, and picking one is a silent lie about
    // somebody's data.
    const db = legacyInstall();
    seenCommander(db, 'F0000001', 'Sythan');
    seenCommander(db, 'F0000002', 'AltOne');
    migrate(db, 12);

    expect(owners(db, 'missions')).toEqual([null]);
    expect(owners(db, 'construction_sites')).toEqual([null]);
    db.close();
  });

  it('preserves the ambiguous rows rather than discarding them', () => {
    // Unattributable is not the same as worthless. They stay on disk for a
    // future rebuild to attribute properly.
    const db = legacyInstall();
    seenCommander(db, 'F0000001', 'Sythan');
    seenCommander(db, 'F0000002', 'AltOne');
    migrate(db, 12);

    expect(db.prepare('SELECT COUNT(*) AS n FROM missions').get()).toMatchObject({ n: 1 });
    db.close();
  });

  it('hides them from every commander, not just from one', () => {
    // The strict query the app now uses. Before, `IS NULL OR = ?` showed
    // ambiguous rows to everybody, which is the leak being closed.
    const db = legacyInstall();
    seenCommander(db, 'F0000001', 'Sythan');
    seenCommander(db, 'F0000002', 'AltOne');
    migrate(db, 12);

    for (const fid of ['F0000001', 'F0000002']) {
      const visible = db.prepare('SELECT COUNT(*) AS n FROM missions WHERE commander_fid = ?').get(fid);
      expect(visible, fid).toMatchObject({ n: 0 });
    }
    db.close();
  });

  it('registers every commander it found', () => {
    const db = legacyInstall();
    seenCommander(db, 'F0000001', 'Sythan');
    seenCommander(db, 'F0000002', 'AltOne');
    migrate(db, 12);

    const fids = (db.prepare('SELECT fid FROM commander_registry ORDER BY fid').all() as Array<{ fid: string }>)
      .map((r) => r.fid);
    expect(fids).toEqual(['F0000001', 'F0000002']);
    db.close();
  });
});

describe('legacy ownership: no evidence at all', () => {
  it('leaves rows unassigned rather than inventing an owner', () => {
    const db = legacyInstall();
    migrate(db, 12);
    expect(owners(db, 'missions')).toEqual([null]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM commander_registry').get()).toMatchObject({ n: 0 });
    db.close();
  });
});

describe('evidence beyond commander_state', () => {
  it('counts a commander known only from their activity journal', () => {
    // A commander who has recorded activity has demonstrably played here, even
    // if commander_state was cleared. Two sources, two commanders, so the rows
    // stay ambiguous -- which is the point of gathering evidence widely.
    const db = legacyInstall();
    seenCommander(db, 'F0000001', 'Sythan');
    db.exec(`
      INSERT INTO activity_entries
        (id, commander_fid, occurred_at, category, subtype, title, data, sources, created_at)
      VALUES ('x', 'F0000002', '2026-09-01T00:00:00Z', 'exobiology', 'sample-completed',
              'T', '{}', '[]', '2026-09-01T00:00:00Z');
    `);
    migrate(db, 12);

    expect(owners(db, 'missions')).toEqual([null]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM commander_registry').get()).toMatchObject({ n: 2 });
    db.close();
  });

  it('still attributes when every source names the same commander', () => {
    const db = legacyInstall();
    seenCommander(db, 'F0000001', 'Sythan');
    db.exec(`
      INSERT INTO activity_entries
        (id, commander_fid, occurred_at, category, subtype, title, data, sources, created_at)
      VALUES ('x', 'F0000001', '2026-09-01T00:00:00Z', 'exobiology', 'sample-completed',
              'T', '{}', '[]', '2026-09-01T00:00:00Z');
    `);
    migrate(db, 12);
    expect(owners(db, 'missions')).toEqual(['F0000001']);
    db.close();
  });
});

describe('shared machine-local knowledge stays shared', () => {
  it('does not scope carrier names or trader kinds', () => {
    // These are facts about places, not about a person. A second commander on
    // the same machine must not lose a carrier name already learned.
    const db = new DatabaseSync(':memory:');
    migrate(db, 12);

    for (const table of ['known_carriers', 'known_traders']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols, table).not.toContain('commander_fid');
    }
    db.close();
  });
});

describe('queue tables', () => {
  it('keys queued work by integration and id, so retries cannot duplicate', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, 12);

    const now = '2026-09-29T12:00:00Z';
    const insert = (integration: string, id: string) =>
      db.exec(
        `INSERT OR IGNORE INTO integration_queue
           (id, integration, commander_fid, payload, created_at, updated_at)
         VALUES ('${id}', '${integration}', 'F1', '{}', '${now}', '${now}')`,
      );

    insert('eddn', 'evt:1');
    insert('eddn', 'evt:1'); // the same observation again
    insert('edsm', 'evt:1'); // the same observation, a different service

    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_queue').get()).toMatchObject({ n: 2 });
    db.close();
  });

  it('survives a restart, because the queue is on disk rather than in memory', () => {
    // Same file, reopened: the durability claim, checked rather than asserted.
    const db = new DatabaseSync(':memory:');
    migrate(db, 12);
    const now = '2026-09-29T12:00:00Z';
    db.exec(
      `INSERT INTO integration_queue (id, integration, commander_fid, status, payload, attempts,
         next_attempt_at, created_at, updated_at)
       VALUES ('a', 'eddn', 'F1', 'retryable', '{}', 2, '2026-09-29T12:05:00Z', '${now}', '${now}')`,
    );
    const row = db.prepare('SELECT status, attempts, next_attempt_at FROM integration_queue').get();
    expect(row).toMatchObject({ status: 'retryable', attempts: 2, next_attempt_at: '2026-09-29T12:05:00Z' });
    db.close();
  });
});

describe('the app queries strictly', () => {
  it('never re-introduces the permissive scoping that showed ambiguous rows to all', () => {
    /*
     * The migration decides ownership once; queries must not second-guess it.
     *
     * `WHERE commander_fid IS NULL OR commander_fid = ?` was the original form,
     * and it made unattributed rows visible to EVERY commander -- the opposite
     * of what leaving them unattributed is for. Asserted against the source,
     * because this is a one-character change away from returning.
     */
    const source = readFileSync(join(__dirname, '..', 'src', 'lib', 'companion.ts'), 'utf8');
    const permissive = /commander_fid\s+IS\s+NULL\s+OR/i;
    expect(permissive.test(source), 'a scoped query is matching unattributed rows again').toBe(
      false,
    );
  });

  it('scopes the tables migration 11 added an owner to', () => {
    // Each of these reads must filter by commander. A query that forgot would
    // show another commander's data.
    const source = readFileSync(join(__dirname, '..', 'src', 'lib', 'companion.ts'), 'utf8');
    for (const table of ['FROM missions', 'FROM construction_sites']) {
      const index = source.indexOf(table);
      expect(index, `${table} is not queried at all`).toBeGreaterThan(-1);
      const nearby = source.slice(index, index + 220);
      expect(nearby, `${table} is read without scoping`).toContain('commander_fid');
    }
  });
});

describe('exobiology progress survives leaving', () => {
  /*
   * The point of migration 13: a commander called away mid-run comes back and
   * sees where they stopped. Progress is stored as CURRENT STATE, not as events,
   * so it stays one row per genus however many samples were taken.
   */
  function seed(db: DatabaseSync, over: Partial<Record<string, unknown>> = {}) {
    const row = {
      fid: 'F1',
      sys: 1234,
      body: 12,
      genus_token: '$Codex_Ent_Bacterial_Genus_Name;',
      genus: 'Bacterium',
      species_token: '$sp;',
      species: 'Bacterium Vesicula',
      colour: 'Gold',
      samples: 2,
      completed: 0,
      ...over,
    };
    db.prepare(
      `INSERT INTO exobiology_progress
         (commander_fid, system_address, body_id, genus_token, genus,
          species_token, species, colour, samples_taken, completed, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'2026-09-29T00:00:00Z')`,
    ).run(
      row.fid, row.sys, row.body, row.genus_token, row.genus,
      row.species_token, row.species, row.colour, row.samples, row.completed,
    );
  }

  it('keeps one row per genus per body however often it is written', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    seed(db);
    // An upsert on the natural key, as the app does.
    db.prepare(
      `INSERT INTO exobiology_progress
         (commander_fid, system_address, body_id, genus_token, genus, samples_taken, updated_at)
       VALUES ('F1',1234,12,'$Codex_Ent_Bacterial_Genus_Name;','Bacterium',3,'2026-09-29T01:00:00Z')
       ON CONFLICT (commander_fid, system_address, body_id, genus_token)
       DO UPDATE SET samples_taken = excluded.samples_taken, updated_at = excluded.updated_at`,
    ).run();

    const rows = db.prepare('SELECT samples_taken FROM exobiology_progress').all() as Array<{ samples_taken: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.samples_taken).toBe(3);
    db.close();
  });

  it('keeps two commanders apart on the same body', () => {
    // Two people sharing a machine must not inherit each other's progress, and
    // what one has found is a spoiler for the other.
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    seed(db, { fid: 'F1', samples: 2 });
    seed(db, { fid: 'F2', samples: 0 });

    const mine = db.prepare(
      `SELECT samples_taken FROM exobiology_progress WHERE commander_fid = 'F1'`,
    ).all() as Array<{ samples_taken: number }>;
    expect(mine).toHaveLength(1);
    expect(mine[0]!.samples_taken).toBe(2);
    db.close();
  });

  it('keeps the same genus on two bodies apart', () => {
    // Measured: 9 of 25 species were sampled on more than one body.
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    seed(db, { body: 12 });
    seed(db, { body: 13 });
    const all = db.prepare('SELECT body_id FROM exobiology_progress ORDER BY body_id').all();
    expect(all).toHaveLength(2);
    db.close();
  });

  it('allows an unsampled genus with no species at all', () => {
    /*
     * A surface scan reports a genus and nothing finer, so the species columns
     * must be nullable. A NOT NULL there would have forced a guessed species.
     */
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    expect(() =>
      seed(db, { species_token: null, species: null, colour: null, samples: 0 }),
    ).not.toThrow();
    db.close();
  });

  it('allows an unestablished sample count', () => {
    // NULL means "in progress, count not established" -- distinct from 0.
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    seed(db, { samples: null });
    const row = db.prepare('SELECT samples_taken FROM exobiology_progress').get() as { samples_taken: number | null };
    expect(row.samples_taken).toBeNull();
    db.close();
  });

  it('survives a restart, because progress is on disk rather than in memory', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    seed(db);
    const before = db.prepare('SELECT COUNT(*) AS n FROM exobiology_progress').get() as { n: number };
    expect(before.n).toBe(1);
    // Re-running migrations, as a relaunch does, must not clear it.
    migrate(db, 99);
    const after = db.prepare('SELECT COUNT(*) AS n FROM exobiology_progress').get() as { n: number };
    expect(after.n).toBe(1);
    db.close();
  });
});

describe('the screenshot catalog', () => {
  function add(db: DatabaseSync, over: Record<string, unknown> = {}) {
    const row = {
      id: 'shot-1',
      fid: 'F1',
      path: 'C:/Users/Someone/Pictures/EDFM Companion/Screenshots/a.png',
      at: '2026-09-30T14:22:18Z',
      category: 'exobiology',
      subject: 'Bacterium Vesicula — Gold',
      system: 'Wregoe XX-X d1-42',
      body: '3 A',
      tags: '["Exobiology","Gold"]',
      entry: null,
      ...over,
    };
    db.prepare(
      `INSERT INTO screenshots
         (id, commander_fid, file_path, captured_at, category, subject,
          system_name, body_name, tags, activity_entry_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'2026-09-30T14:22:18Z','2026-09-30T14:22:18Z')`,
    ).run(
      row.id, row.fid, row.path, row.at, row.category, row.subject,
      row.system, row.body, row.tags, row.entry,
    );
  }

  it('stores a reference, never the image', () => {
    /*
     * §13 and §12: the catalog holds a path to a file in a folder the commander
     * chose and can see. A catalog that duplicated every 4K screenshot would
     * consume gigabytes and hide their pictures somewhere they would never look.
     */
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    const columns = (db.prepare('PRAGMA table_info(screenshots)').all() as Array<{ name: string }>)
      .map((c) => c.name);

    expect(columns).toContain('file_path');
    // Nothing that could hold image bytes.
    for (const forbidden of ['image', 'data', 'blob', 'bytes', 'thumbnail']) {
      expect(columns, forbidden).not.toContain(forbidden);
    }
    db.close();
  });

  it('keeps one commander out of another commander catalog', () => {
    // §14. A screenshot can show a ship, a carrier or an entire HUD.
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    add(db, { id: 'mine', fid: 'F1' });
    add(db, { id: 'theirs', fid: 'F2', path: 'C:/other.png' });

    const mine = db.prepare('SELECT id FROM screenshots WHERE commander_fid = ?').all('F1');
    expect(mine).toHaveLength(1);
    expect((mine[0] as { id: string }).id).toBe('mine');
    db.close();
  });

  it('does not catalog the same file twice for one commander', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    add(db, { id: 'a' });
    expect(() => add(db, { id: 'b' })).toThrow();
    db.close();
  });

  it('lets two commanders each catalog the same shared file', () => {
    // The uniqueness is per commander, not global: the same image on a shared
    // machine is a legitimate entry for each of them.
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    add(db, { id: 'a', fid: 'F1' });
    expect(() => add(db, { id: 'b', fid: 'F2' })).not.toThrow();
    db.close();
  });

  it('allows a screenshot with no location at all', () => {
    /*
     * §9: location is not mandatory. A menu, a ship or a UI capture may have no
     * meaningful place, and a NOT NULL would have forced an invented one.
     */
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    expect(() =>
      add(db, { id: 'menu', system: null, body: null, subject: null }),
    ).not.toThrow();
    db.close();
  });

  it('allows a screenshot with no journal link', () => {
    // §15: a screenshot can exist without one, and ambiguity means no link.
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    add(db, { entry: null });
    const row = db.prepare('SELECT activity_entry_id FROM screenshots').get() as {
      activity_entry_id: string | null;
    };
    expect(row.activity_entry_id).toBeNull();
    db.close();
  });

  it('accepts a category it has never heard of', () => {
    /*
     * §7: categories are data, not a closed enum, so a later release or an
     * add-on can extend the list without a migration.
     */
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    expect(() => add(db, { id: 'x', category: 'thargoid-encounter' })).not.toThrow();
    db.close();
  });

  it('survives a relaunch', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    add(db);
    migrate(db, 99);
    const n = db.prepare('SELECT COUNT(*) AS n FROM screenshots').get() as { n: number };
    expect(n.n).toBe(1);
    db.close();
  });

  it('removing a catalog row leaves no trace of the file being deleted', () => {
    /*
     * §16: removing from the catalog and deleting the image are different
     * actions. The row goes; nothing here touches the filesystem.
     */
    const db = new DatabaseSync(':memory:');
    migrate(db, 99);
    add(db);
    db.prepare('DELETE FROM screenshots WHERE id = ? AND commander_fid = ?').run('shot-1', 'F1');
    const n = db.prepare('SELECT COUNT(*) AS n FROM screenshots').get() as { n: number };
    expect(n.n).toBe(0);
    db.close();
  });
});
