"""Independent paid liability authority; operational journal outages are distinct."""
from __future__ import annotations

import contextlib
import os
import sqlite3


class BudgetUnavailable(Exception):
    pass


class BudgetExhausted(Exception):
    pass


class Budget:
    def __init__(self, path):
        self.path = path

    @contextlib.contextmanager
    def connection(self, write=False, create=False):
        db = None
        try:
            # Do not silently replace a missing authority with an empty budget.
            if not create and not os.path.isfile(self.path):
                raise BudgetUnavailable('paid budget authority is unavailable')
            db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA busy_timeout=5000')
            db.execute('PRAGMA synchronous=FULL')
            if write:
                db.execute('BEGIN IMMEDIATE')
            yield db
            if write:
                db.commit()
        except (sqlite3.Error, OSError) as error:
            if db is not None and write:
                db.rollback()
            raise BudgetUnavailable('paid budget authority is unavailable') from error
        except BaseException:
            if db is not None and write:
                db.rollback()
            raise
        finally:
            if db is not None:
                db.close()

    def initialize(self, attempts):
        with self.connection(write=True, create=True) as db:
            db.execute('''CREATE TABLE IF NOT EXISTS liabilities(
                id TEXT PRIMARY KEY, admitted_date TEXT NOT NULL,
                reserved_microusd INTEGER NOT NULL, cost_microusd INTEGER,
                status TEXT NOT NULL)''')
            # Restarting an interrupted migration retains prior/orphan liabilities.
            for row in attempts:
                db.execute('INSERT OR IGNORE INTO liabilities VALUES(?,?,?,?,?)',
                           (row['id'], row['admitted_date'], row['reserved_microusd'],
                            row['cost_microusd'] if row['status'] == 'settled' else None,
                            'settled' if row['status'] == 'settled' else 'reserved'))

    @staticmethod
    def totals(db, date):
        row = db.execute('''SELECT
            COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_microusd ELSE 0 END),0) reserved,
            COALESCE(SUM(cost_microusd),0) spent FROM liabilities WHERE admitted_date=?''', (date,)).fetchone()
        return {'spent_microusd': row['spent'], 'reserved_microusd': row['reserved']}

    def state(self, date):
        with self.connection() as db:
            return self.totals(db, date)

    def reserve(self, attempt_id, date, amount, limit):
        with self.connection(write=True) as db:
            totals = self.totals(db, date)
            if totals['spent_microusd'] + totals['reserved_microusd'] + amount > limit:
                raise BudgetExhausted('daily paid budget exhausted')
            db.execute('INSERT INTO liabilities VALUES(?,?,?,NULL,?)', (attempt_id, date, amount, 'reserved'))

    def settle(self, attempt_id, cost):
        with self.connection(write=True) as db:
            db.execute("UPDATE liabilities SET status='settled',cost_microusd=? WHERE id=? AND status='reserved'", (cost, attempt_id))

    def reconcile(self, attempts):
        with self.connection(write=True) as db:
            for row in attempts:
                db.execute("UPDATE liabilities SET status='settled',cost_microusd=? WHERE id=? AND status='reserved'",
                           (row['cost_microusd'], row['id']))
