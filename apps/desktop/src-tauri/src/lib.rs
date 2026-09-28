//! EDFM Companion desktop shell.
//!
//! The native layer stays deliberately thin: known-folder resolution, narrow
//! journal read commands, directory watching, and SQLite migrations. All parsing,
//! normalization and state live in TypeScript so that replay and live ingestion run
//! the identical pipeline (see docs/ARCHITECTURE.md §2.2).

mod journal;
mod overlay;
mod plugins;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Phase 1 local schema.
///
/// Normalized tables rather than a generic JSON blob store (§26). `journal_checkpoint`
/// is the mechanism behind restart-without-duplicate-events.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "phase 1 foundation",
        sql: r#"
            CREATE TABLE IF NOT EXISTS settings (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            -- One row per commander (FID), so switching commanders cannot make one
            -- resume at another's offset.
            CREATE TABLE IF NOT EXISTS journal_checkpoint (
                scope         TEXT PRIMARY KEY,
                source_file   TEXT NOT NULL,
                byte_offset   INTEGER NOT NULL,
                last_event_id TEXT,
                updated_at    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS commander_state (
                fid           TEXT PRIMARY KEY,
                commander     TEXT,
                game_version  TEXT,
                build         TEXT,
                star_system   TEXT,
                system_address INTEGER,
                station_name  TEXT,
                market_id     INTEGER,
                docking       TEXT NOT NULL DEFAULT 'unknown',
                vehicle       TEXT NOT NULL DEFAULT 'unknown',
                ship          TEXT,
                cargo_count   INTEGER,
                updated_at    TEXT NOT NULL
            );

            -- Ingest counters for the diagnostics screen (§25). Keeps no journal
            -- content, only aggregate counts.
            CREATE TABLE IF NOT EXISTS ingest_stats (
                id              INTEGER PRIMARY KEY CHECK (id = 1),
                lines_read      INTEGER NOT NULL DEFAULT 0,
                events_emitted  INTEGER NOT NULL DEFAULT 0,
                malformed_json  INTEGER NOT NULL DEFAULT 0,
                rotations       INTEGER NOT NULL DEFAULT 0,
                updated_at      TEXT NOT NULL
            );

            -- Names only, never payloads: an unknown event's body can contain
            -- commander detail we have no reason to persist (§21).
            CREATE TABLE IF NOT EXISTS unknown_events (
                event_name   TEXT PRIMARY KEY,
                count        INTEGER NOT NULL DEFAULT 0,
                first_seen   TEXT NOT NULL,
                last_seen    TEXT NOT NULL,
                game_version TEXT
            );
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 2,
        description: "remember fleet carrier identities",
        sql: r#"
            -- Docked at a carrier reports only the callsign; the name arrives in
            -- CarrierStats, which is emitted when carrier management is opened --
            -- not every session. Without persistence the name is unavailable in
            -- any session where the commander did not open that panel.
            CREATE TABLE IF NOT EXISTS known_carriers (
                carrier_id  INTEGER PRIMARY KEY,
                name        TEXT NOT NULL,
                callsign    TEXT,
                updated_at  TEXT NOT NULL
            );
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 3,
        description: "missions",
        sql: r#"
            -- Explicit columns rather than a JSON blob (§26): missions are a
            -- first-class entity that later phases group and query.
            --
            -- Every optional column is nullable, and NULL means "the game did not
            -- report this" -- distinct from 0 or ''. Collapsing that distinction
            -- on the way to disk would destroy it across a restart.
            CREATE TABLE IF NOT EXISTS missions (
                mission_id             INTEGER PRIMARY KEY,
                id_reliable            INTEGER NOT NULL DEFAULT 1,
                name                   TEXT NOT NULL,
                type_key               TEXT NOT NULL,
                category               TEXT NOT NULL,
                localised_name         TEXT,
                faction                TEXT,
                influence              TEXT,
                reputation             TEXT,
                wing                   INTEGER,
                destination_system     TEXT,
                destination_station    TEXT,
                destination_settlement TEXT,
                target_faction         TEXT,
                target                 TEXT,
                target_type            TEXT,
                commodity              TEXT,
                commodity_localised    TEXT,
                count                  INTEGER,
                kill_count             INTEGER,
                passenger_count        INTEGER,
                passenger_type         TEXT,
                passenger_vips         INTEGER,
                passenger_wanted       INTEGER,
                reward                 INTEGER,
                donation               INTEGER,
                expiry                 TEXT,
                status                 TEXT NOT NULL,
                redirected             INTEGER NOT NULL DEFAULT 0,
                accepted_at            TEXT NOT NULL,
                source_event_id        TEXT NOT NULL,
                game_version           TEXT,
                ended_at               TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
            CREATE INDEX IF NOT EXISTS idx_missions_expiry ON missions(expiry);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 4,
        description: "cargo delivery progress",
        sql: r#"
            -- From CargoDepot, which is the one kind of mission progress Elite
            -- genuinely journals. NULL means no depot event has been seen for the
            -- mission -- not that nothing has been delivered.
            ALTER TABLE missions ADD COLUMN delivered INTEGER;
            ALTER TABLE missions ADD COLUMN total_to_deliver INTEGER;
            ALTER TABLE missions ADD COLUMN collected INTEGER;
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 5,
        description: "discovery state and verification",
        sql: r#"
            -- What THIS commander's game has revealed to them. The sole basis
            -- for spoiler gating: EDFM's data is never a discovery source.
            --
            -- Keyed by commander FID so two commanders sharing a PC cannot
            -- inherit each other's discoveries. Persisted so that restarting
            -- the Companion neither loses legitimate discoveries nor reveals
            -- anything merely because server data exists.
            CREATE TABLE IF NOT EXISTS discovery_state (
                commander_fid TEXT PRIMARY KEY,
                state         TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );

            -- Discrepancies awaiting submission. Held locally so an offline
            -- session loses nothing (§22), and so submission is a separate,
            -- opt-in act from detection.
            CREATE TABLE IF NOT EXISTS verification_queue (
                key            TEXT PRIMARY KEY,
                entity_type    TEXT NOT NULL,
                entity_id      TEXT NOT NULL,
                field          TEXT NOT NULL,
                kind           TEXT NOT NULL,
                status         TEXT NOT NULL,
                volatility     TEXT NOT NULL,
                -- Serialised visibility gate. Travels with the record so
                -- redaction is decided by the data rather than by whichever
                -- code path happens to render or notify.
                visibility     TEXT NOT NULL,
                expected_value TEXT,
                observed_value TEXT,
                observations   TEXT NOT NULL,
                independent    INTEGER NOT NULL DEFAULT 1,
                first_seen_at  TEXT NOT NULL,
                last_seen_at   TEXT NOT NULL,
                submitted_at   TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_verification_pending
                ON verification_queue (submitted_at) WHERE submitted_at IS NULL;
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 6,
        description: "field research sessions",
        sql: r#"
            -- Observed research sessions (§12). Deliberately NOT called loot
            -- runs: the app cannot know whether every container was searched,
            -- whether someone looted first, or whether areas were skipped, so
            -- completeness defaults to 'unknown' and is only ever set by the
            -- commander.
            CREATE TABLE IF NOT EXISTS research_sessions (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL,
                -- Recorded per session so methodology changes can be separated
                -- rather than silently mixed into one dataset.
                project_version INTEGER NOT NULL,

                started_at      TEXT NOT NULL,
                ended_at        TEXT,
                duration_s      INTEGER,

                -- Project-defined; the framework does not know what a project
                -- cares about, so this stays JSON rather than columns.
                context         TEXT NOT NULL,
                observations    TEXT NOT NULL,

                outcome         TEXT NOT NULL,
                end_event       TEXT,
                completeness    TEXT NOT NULL DEFAULT 'unknown',

                commander       TEXT,
                commander_fid   TEXT,
                -- §12: builds must be recorded so data from materially
                -- different patches can be separated.
                game_version    TEXT,
                game_build      TEXT,
                companion_version TEXT NOT NULL,
                session_key     TEXT NOT NULL,

                -- Separate from ended_at: a session is recorded long before,
                -- and independently of, any decision to contribute it.
                submitted_at    TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_research_project
                ON research_sessions (project_id, started_at DESC);
            -- Scoped by commander, like discovery state: two commanders sharing
            -- a PC must not have their observations pooled.
            CREATE INDEX IF NOT EXISTS idx_research_commander
                ON research_sessions (commander_fid, started_at DESC);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 7,
        description: "observation submission queue",
        sql: r#"
            -- Observations waiting to be offered to EDFM.
            --
            -- The client submits what its game reported, never a finding: a
            -- finding is a claim about what the reference says, and the client
            -- does not hold the reference. The server re-derives the
            -- comparison, and `findings` records what it derived, so a
            -- client-side comparison bug shows up as a disagreement instead of
            -- quietly shaping the corpus.
            CREATE TABLE IF NOT EXISTS observation_queue (
                -- file:byteOffset. As the primary key it deduplicates for
                -- free: replay and restart re-read the same journal lines, and
                -- neither may queue the same observation twice.
                source_event_id TEXT PRIMARY KEY,
                entity_type     TEXT NOT NULL,
                entity_id       TEXT NOT NULL,
                -- The observation verbatim. Held so the payload can be shown
                -- to the commander before it is sent (S21) and so a queued row
                -- survives a client upgrade that changes the request shape.
                payload         TEXT NOT NULL,
                observed_at     TEXT NOT NULL,
                queued_at       TEXT NOT NULL,

                attempts        INTEGER NOT NULL DEFAULT 0,
                -- Set only once the server has accepted it. Nothing else marks
                -- an observation contributed.
                submitted_at    TEXT,
                -- What the server derived. Null until accepted.
                findings        INTEGER,
                last_error      TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_observation_pending
                ON observation_queue (queued_at) WHERE submitted_at IS NULL;
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 8,
        description: "construction sites",
        sql: r#"
            -- Colonisation construction sites (S17).
            --
            -- Tracked automatically, which was checked before being claimed:
            -- ColonisationConstructionDepot carries RequiredAmount and
            -- ProvidedAmount per commodity at 100% presence across 5,703
            -- measured events, so remaining is reported by the game rather
            -- than inferred from deliveries.
            --
            -- Each depot event is a COMPLETE snapshot, so this row is replaced
            -- wholesale rather than merged. A missed event cannot corrupt a
            -- total; the next one simply supersedes it.
            CREATE TABLE IF NOT EXISTS construction_sites (
                -- The depot's MarketID. Stable identity for the site.
                market_id     TEXT PRIMARY KEY,
                -- 0..1 as the game reports it. NULL means it never said.
                progress      REAL,
                complete      INTEGER NOT NULL DEFAULT 0,
                failed        INTEGER NOT NULL DEFAULT 0,
                -- Per-commodity required/provided, verbatim plus the folded
                -- market symbol. Kept as JSON because the set of commodities is
                -- Frontier's to change, not ours to enumerate in columns.
                resources     TEXT NOT NULL,

                -- Commander-assigned. The game does not name depots, and with
                -- several sites running a commander needs to tell them apart
                -- and say which matters most.
                name          TEXT,
                priority      INTEGER NOT NULL DEFAULT 1,

                updated_at    TEXT NOT NULL,
                first_seen_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sites_active
                ON construction_sites (complete, failed, updated_at DESC);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 9,
        description: "remember material trader kinds",
        sql: r#"
            -- Which kind of Material Trader a station has is not in
            -- StationServices, which says only `materialtrader` -- measured over
            -- 141 docks with no field naming the type anywhere. Only
            -- MaterialTrade.TraderType names it, so it is known for stations the
            -- commander has traded at and must stay unknown for the rest.
            --
            -- Worth persisting for the same reason as known_carriers: the trade
            -- that revealed it may have been months ago, and without this the
            -- answer is lost every restart.
            --
            -- Stable in practice: across 29 stations with observed trades, none
            -- ever reported a second TraderType. Stored as a plain upsert on that
            -- basis, with updated_at kept so a future change is at least visible.
            CREATE TABLE IF NOT EXISTS known_traders (
                market_id   INTEGER PRIMARY KEY,
                trader_type TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 10,
        description: "activity journal",
        sql: r#"
            -- The commander's own field journal: what they did, in readable
            -- form. NOT a copy of Frontier's journal, which already exists and
            -- is already machine-readable. Only derived activity is stored,
            -- plus enough provenance to audit how each entry was produced.
            --
            -- `id` is derived from the journal event that produced the entry
            -- (`sourceFile:byteOffset`), which the engine already guarantees is
            -- stable across restarts and replay. That makes deduplication a
            -- property of the primary key rather than a procedure that can be
            -- got wrong: re-reading a file re-derives the same ids and the
            -- INSERT is simply ignored.
            CREATE TABLE IF NOT EXISTS activity_entries (
                id             TEXT PRIMARY KEY,
                -- Two commanders on one machine must not inherit each other's
                -- history. Local only; never transmitted (docs/PRIVACY.md).
                commander_fid  TEXT NOT NULL,
                occurred_at    TEXT NOT NULL,
                category       TEXT NOT NULL,
                subtype        TEXT NOT NULL,

                system_name    TEXT,
                system_address INTEGER,
                -- NULL is meaningful: ScanOrganic reports a BodyID, not a name,
                -- and "nothing has told us the name" is not the same as "no body".
                body_name      TEXT,
                body_id        INTEGER,
                location_name  TEXT,

                title          TEXT NOT NULL,
                detail         TEXT,
                -- Structured form of the same activity, so a later export or
                -- search need not re-parse the prose.
                data           TEXT NOT NULL,
                -- The journal event ids this was derived from. An entry that
                -- cannot be traced back is one nobody can check.
                sources        TEXT NOT NULL,

                created_at     TEXT NOT NULL
            );

            -- The timeline query: this commander's activity, newest first,
            -- optionally filtered by category.
            CREATE INDEX IF NOT EXISTS idx_activity_timeline
                ON activity_entries (commander_fid, occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_activity_category
                ON activity_entries (commander_fid, category, occurred_at DESC);
            -- Future search by place, which is how a commander actually looks
            -- for something they remember doing.
            CREATE INDEX IF NOT EXISTS idx_activity_system
                ON activity_entries (commander_fid, system_name);

            -- Sessions and notes: schema now, population later.
            --
            -- Defined in this migration on purpose. An automatic session
            -- boundary is a guess about intent and will not be presented as a
            -- fact until there is a rule worth defending, but adding the tables
            -- later would be a migration against a table users already have
            -- data in. Empty tables cost nothing.
            CREATE TABLE IF NOT EXISTS activity_sessions (
                id            TEXT PRIMARY KEY,
                commander_fid TEXT NOT NULL,
                started_at    TEXT NOT NULL,
                ended_at      TEXT,
                name          TEXT,
                category      TEXT
            );

            CREATE TABLE IF NOT EXISTS activity_notes (
                id            TEXT PRIMARY KEY,
                commander_fid TEXT NOT NULL,
                -- Exactly one of these is set.
                entry_id      TEXT REFERENCES activity_entries(id) ON DELETE CASCADE,
                session_id    TEXT REFERENCES activity_sessions(id) ON DELETE CASCADE,
                body          TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );
        "#,
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Outbound HTTP goes through Rust, not the WebView.
        //
        // The WebView's CSP would otherwise have to name the API origin, and the
        // API would have to relax CORS for the app's origin -- weakening the
        // server for every client in order to serve this one. Routing through the
        // plugin keeps the API same-origin-only from any browser's point of view,
        // and puts the allowlist in `capabilities/default.json`, where it is
        // enforced natively and is auditable in one place.
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:edfm-companion.db", migrations())
                .build(),
        )
        .manage(journal::WatcherState::default())
        .manage(overlay::OverlayState::default())
        .setup(|app| {
            // Arm click-through at creation, before the overlay can ever be shown.
            // The overlay is sized to the whole game window, so an interactive one
            // swallows every click in that area.
            use tauri::Manager;
            if let Some(win) = app.get_webview_window(overlay::OVERLAY_LABEL) {
                let _ = win.set_ignore_cursor_events(true);
            }
            Ok(())
        })
        // Closing the main window quits the application.
        //
        // Without this the process survived closing the window and had to be killed
        // from Task Manager. The overlay is a second real window, and Tauri runs
        // until every window is gone -- but the overlay is `skipTaskbar` with no
        // decorations and is click-through by design, so nothing the user could see
        // or click was left to close. The app was alive and unreachable.
        //
        // Exiting immediately is safe: the journal checkpoint is what makes restart
        // resume without duplicating events, and the frontend flushes it on a
        // three-second timer, so the worst case is re-reading a few seconds of
        // journal -- which the checkpoint mechanism already exists to handle.
        .on_window_event(|window, event| {
            use tauri::Manager;

            if !matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                return;
            }
            // Only the main window. The overlay closing must never take the app with
            // it, and a future second window should not either.
            if window.label() != "main" {
                return;
            }

            let app = window.app_handle();
            // Stop the tracker thread before exiting, rather than leaving it polling
            // for a game window while the process tears down around it.
            if let Some(state) = app.try_state::<overlay::OverlayState>() {
                state
                    .running
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                state
                    .editing
                    .store(false, std::sync::atomic::Ordering::SeqCst);
            }
            app.exit(0);
        })
        .invoke_handler(tauri::generate_handler![
            journal::saved_games_dir,
            journal::journal_read_dir,
            journal::journal_file_size,
            journal::journal_is_dir,
            journal::journal_read_range,
            journal::journal_watch,
            journal::journal_unwatch,
            overlay::elite_window_info,
            plugins::plugins_dir,
            plugins::plugins_read,
            plugins::plugins_open_folder,
            overlay::elite_display_mode,
            overlay::overlay_start,
            overlay::overlay_stop,
            overlay::overlay_set_edit_mode,
            overlay::overlay_push_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running EDFM Companion");
}

#[cfg(test)]
mod tests {
    /// The exit handler matches on the window label `"main"`, and the overlay is
    /// deliberately excluded from it. Renaming either label would silently stop the
    /// app quitting when its window is closed -- the bug that previously left the
    /// process running with only an invisible, click-through, taskbar-less overlay
    /// alive, reachable solely through Task Manager.
    #[test]
    fn window_labels_the_exit_handler_depends_on_still_exist() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let windows = config["app"]["windows"]
            .as_array()
            .expect("app.windows array");

        let labels: Vec<&str> = windows
            .iter()
            .filter_map(|w| w["label"].as_str())
            .collect();
        assert!(labels.contains(&"main"), "labels were {labels:?}");
        assert!(labels.contains(&super::overlay::OVERLAY_LABEL), "labels were {labels:?}");

        // And the reason the bug was unrecoverable: the overlay is unreachable by
        // design, so it must never be the thing keeping the process alive.
        let overlay = windows
            .iter()
            .find(|w| w["label"].as_str() == Some(super::overlay::OVERLAY_LABEL))
            .expect("overlay window");
        assert_eq!(overlay["skipTaskbar"].as_bool(), Some(true));
        assert_eq!(overlay["decorations"].as_bool(), Some(false));
    }
}
