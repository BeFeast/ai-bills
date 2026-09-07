"""SQLite admission ledger. Open reservations intentionally survive process crashes."""
from __future__ import annotations

import contextlib
import datetime as dt
import json
import sqlite3
import uuid
from zoneinfo import ZoneInfo

from policy import empty_policy, preview, propose, validate
from budget import Budget, BudgetUnavailable, BudgetExhausted


class Rejected(Exception):
    def __init__(self, message: str, status: int = 400):
        self.message, self.status = message, status
        super().__init__(message)


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def billing_date(now):
    return now.astimezone(ZoneInfo("Asia/Jerusalem")).date().isoformat()


class Store:
    def __init__(self, path: str, clock=utcnow):
        self.path, self.clock = path, clock
        self.budget_authority = Budget(path + ".budget.sqlite")
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS policy(version INTEGER PRIMARY KEY, body TEXT NOT NULL, applied_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(client TEXT NOT NULL, session TEXT NOT NULL, selected TEXT NOT NULL,
                    model TEXT, account TEXT, pending TEXT, PRIMARY KEY(client,session));
                CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL, client_id TEXT NOT NULL,
                    session_id TEXT NOT NULL, requested_model TEXT NOT NULL, role TEXT, model TEXT NOT NULL,
                    account_id TEXT NOT NULL, billing TEXT NOT NULL, status TEXT NOT NULL, admitted_date TEXT NOT NULL,
                    reserved_microusd INTEGER NOT NULL, cost_microusd INTEGER, created_at TEXT NOT NULL,
                    fallback_reason TEXT, usage TEXT, error TEXT, policy_version INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS attempts_date ON attempts(admitted_date);
                CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, body TEXT NOT NULL,
                    created_at TEXT NOT NULL, delivered_at TEXT);
                CREATE TABLE IF NOT EXISTS suggestions(id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS discovery(source TEXT PRIMARY KEY, checked_at TEXT NOT NULL,
                    succeeded_at TEXT, error TEXT, catalog TEXT);
                CREATE TABLE IF NOT EXISTS client_requests(client TEXT NOT NULL, client_request_id TEXT NOT NULL,
                    request_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(client,client_request_id));
            """)
            if not db.execute("SELECT 1 FROM policy LIMIT 1").fetchone():
                db.execute("INSERT INTO policy VALUES(0,?,?)", (json.dumps(empty_policy()), self.clock().isoformat()))
            columns = {r[1] for r in db.execute("PRAGMA table_info(attempts)")}
            for name in ("prices", "price_version", "client_request_id", "client_turn_id", "upstream_model"):
                if name not in columns:
                    db.execute(f"ALTER TABLE attempts ADD COLUMN {name} TEXT")

        # Serialize migration against every old/new admission. Import all existing
        # liabilities before marking complete; a missing authority after this point
        # is unknown, never a reason to recreate an empty day.
        with self.connection(write=True) as db:
            if not db.execute("SELECT 1 FROM metadata WHERE key='budget_initialized'").fetchone():
                rows = db.execute("SELECT * FROM attempts WHERE billing='paid'").fetchall()
                try:
                    self.budget_authority.initialize(rows)
                except BudgetUnavailable:
                    pass
                else:
                    db.execute("INSERT INTO metadata VALUES('budget_initialized','1')")

    @contextlib.contextmanager
    def connection(self, write=False):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=15000")
        db.execute("PRAGMA synchronous=FULL")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.commit()
        except BaseException:
            if write:
                db.rollback()
            raise
        finally:
            db.close()

    def event(self, db, kind, body):
        db.execute("INSERT INTO outbox(kind,body,created_at) VALUES(?,?,?)", (kind, json.dumps(body), self.clock().isoformat()))

    def policy(self, db=None):
        if db is not None:
            return json.loads(db.execute("SELECT body FROM policy ORDER BY version DESC LIMIT 1").fetchone()[0])
        with self.connection() as conn:
            return self.policy(conn)

    def apply(self, policy, expected):
        errors = validate(policy)
        if errors:
            raise Rejected("; ".join(errors))
        with self.connection(write=True) as db:
            current = self.policy(db)
            if type(expected) is not int or current["version"] != expected:
                raise Rejected("policy version conflict", 409)
            body = dict(policy, version=expected + 1)
            db.execute("INSERT INTO policy VALUES(?,?,?)", (body["version"], json.dumps(body), self.clock().isoformat()))
            self.event(db, "policy.applied", {"version": body["version"], "diff": preview(current, body)})
            return body

    def acquire_session(self, client, session, selected, request_id, client_request_id=None):
        with self.connection(write=True) as db:
            if client_request_id:
                if db.execute("SELECT 1 FROM client_requests WHERE client=? AND client_request_id=?", (client, client_request_id)).fetchone():
                    raise Rejected("client request already admitted; automatic replay rejected", 409)
                db.execute("INSERT INTO client_requests VALUES(?,?,?,?)", (client, client_request_id, request_id, self.clock().isoformat()))
            previous = db.execute("SELECT * FROM sessions WHERE client=? AND session=?", (client, session)).fetchone()
            if previous and previous["pending"]:
                raise Rejected("session has an active or unresolved request", 409)
            # A deliberate manual selection starts a new binding in the same conversation.
            if previous and previous["selected"] == selected:
                db.execute("UPDATE sessions SET pending=? WHERE client=? AND session=?", (request_id, client, session))
                return dict(previous)
            db.execute("INSERT INTO sessions VALUES(?,?,?,NULL,NULL,?) ON CONFLICT(client,session) DO UPDATE SET selected=excluded.selected,model=NULL,account=NULL,pending=excluded.pending", (client, session, selected, request_id))
            return None

    def release_session(self, client, session, request_id):
        with self.connection(write=True) as db:
            db.execute("UPDATE sessions SET pending=NULL WHERE client=? AND session=? AND pending=?", (client, session, request_id))

    def budget(self, db=None, date=None):
        date = date or billing_date(self.clock())
        if db is None:
            with self.connection() as conn:
                return self.budget(conn, date)
        base = {"date": date, "limit_microusd": self.policy(db)["day_limit_microusd"]}
        try:
            return {**base, **self.budget_authority.state(date), "available": True}
        except BudgetUnavailable:
            return {**base, "spent_microusd": None, "reserved_microusd": None, "available": False}

    def reconcile_budget(self):
        with self.connection() as db:
            rows = db.execute("SELECT id,cost_microusd FROM attempts WHERE billing='paid' AND status='settled'").fetchall()
        try:
            self.budget_authority.reconcile(rows)
        except BudgetUnavailable:
            pass

    def admit(self, *, policy_version, request_id, client_id, session_id, requested_model, role,
              model, account_id, billing, reserve, fallback_reason=None, prices=None, price_version=None,
              client_request_id=None, client_turn_id=None, upstream_model=None):
        if type(reserve) is not int or reserve < 0:
            raise Rejected("invalid reservation")
        now = self.clock()
        with self.connection(write=True) as db:
            active = self.policy(db)
            if active["version"] != policy_version:
                raise Rejected("policy changed; retry request", 409)
            aid = str(uuid.uuid4())
            if billing == "paid":
                try:
                    # Commit liability first. If operational journaling then fails,
                    # retain this orphan reservation: no request may be replayed.
                    self.budget_authority.reserve(aid, billing_date(now), reserve, active["day_limit_microusd"])
                except BudgetUnavailable:
                    raise Rejected("paid budget unavailable; included routes remain available", 503)
                except BudgetExhausted:
                    raise Rejected("daily paid budget exhausted", 402)
            record = {"id": aid, "request_id": request_id, "client_id": client_id, "session_id": session_id,
                      "requested_model": requested_model, "role": role, "model": model, "account_id": account_id,
                      "billing": billing, "status": "admitted", "admitted_date": billing_date(now),
                      "reserved_microusd": reserve, "cost_microusd": None, "created_at": now.isoformat(),
                      "fallback_reason": fallback_reason, "policy_version": policy_version,
                      "prices": json.dumps(prices) if prices is not None else None, "price_version": price_version,
                      "client_request_id": client_request_id, "client_turn_id": client_turn_id, "upstream_model": upstream_model}
            columns = ",".join(record)
            db.execute(f"INSERT INTO attempts({columns}) VALUES({','.join('?' for _ in record)})", tuple(record.values()))
            self.event(db, "attempt.admitted", record)
            return record

    def finish(self, attempt_id, *, cost=None, usage=None, error=None, complete=False, successful=False):
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM attempts WHERE id=?", (attempt_id,)).fetchone()
            if not row or row["status"] not in ("admitted", "unresolved"):
                return
            if row["billing"] == "included":
                cost = 0
            if cost is not None and (type(cost) is not int or cost < 0):
                raise Rejected("invalid settlement")
            status = "settled" if complete and cost is not None else "unresolved"
            db.execute("UPDATE attempts SET status=?,cost_microusd=?,usage=?,error=? WHERE id=?",
                       (status, cost if status == "settled" else None, json.dumps(usage) if usage else None, error, attempt_id))
            if successful:
                db.execute("UPDATE sessions SET model=?,account=? WHERE client=? AND session=? AND pending=?",
                           (row["model"], row["account_id"], row["client_id"], row["session_id"], row["request_id"]))
            self.event(db, "attempt." + status, {"id": attempt_id, "cost_microusd": cost if status == "settled" else None,
                                               "usage": usage, "error": error})
        if row["billing"] == "paid" and status == "settled":
            try:
                self.budget_authority.settle(attempt_id, cost)
            except BudgetUnavailable:
                # Preserve the higher liability until authority recovery. The
                # durable operational receipt permits idempotent reconciliation.
                pass

    def state(self):
        with self.connection() as db:
            requests = [dict(r) for r in db.execute("SELECT * FROM attempts ORDER BY created_at DESC LIMIT 200")]
            for item in requests:
                item["usage"] = json.loads(item["usage"]) if item["usage"] else None
                item["prices"] = json.loads(item["prices"]) if item["prices"] else None
            suggestions = [dict(json.loads(r["body"]), id=r["id"], status=r["status"], created_at=r["created_at"]) for r in db.execute("SELECT * FROM suggestions ORDER BY created_at DESC")]
            sources = [dict(r) for r in db.execute("SELECT source,checked_at,succeeded_at,error FROM discovery")]
            return {"policy": self.policy(db), "budget": self.budget(db), "requests": requests, "suggestions": suggestions, "discovery": sources}

    def events(self, after=0, limit=100):
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 500:
            raise Rejected("invalid event cursor or limit")
        with self.connection() as db:
            rows = [{"seq": row["seq"], "kind": row["kind"], "body": json.loads(row["body"]), "created_at": row["created_at"]}
                    for row in db.execute("SELECT * FROM outbox WHERE seq>? ORDER BY seq LIMIT ?", (after, limit))]
            return {"events": rows, "next_cursor": rows[-1]["seq"] if rows else after}

    def unresolved(self, limit=100):
        with self.connection() as db:
            result = [dict(row) for row in db.execute("SELECT * FROM attempts WHERE status IN ('admitted','unresolved') ORDER BY created_at DESC LIMIT ?", (limit,))]
            for row in result:
                row["prices"] = json.loads(row["prices"]) if row["prices"] else None
            return result

    def client_events(self, client_id, session_id, after=0, limit=100):
        if type(after) is not int or after < 0 or not isinstance(session_id, str) or not session_id or len(session_id) > 256:
            raise Rejected("invalid session event cursor")
        with self.connection() as db:
            rows = db.execute("SELECT e.seq,e.kind,e.created_at,a.* FROM outbox e JOIN attempts a ON a.id=json_extract(e.body,'$.id') WHERE e.seq>? AND a.client_id=? AND a.session_id=? ORDER BY e.seq LIMIT ?",
                              (after, client_id, session_id, min(100, limit))).fetchall()
            events = []
            for row in rows:
                body = {k: row[k] for k in ("request_id", "client_request_id", "client_turn_id", "role", "model", "account_id", "fallback_reason", "status", "error")}
                body["attempt_id"] = row["id"]
                events.append({"seq": row["seq"], "kind": row["kind"], "created_at": row["created_at"], "body": body})
            return {"events": events, "next_cursor": events[-1]["seq"] if events else after}

    def discovery_state(self, source):
        with self.connection() as db:
            row = db.execute("SELECT * FROM discovery WHERE source=?", (source,)).fetchone()
            return dict(row) if row else None

    def record_discovery(self, source, models=None, error=None):
        now = self.clock().isoformat()
        with self.connection(write=True) as db:
            if error:
                db.execute("INSERT INTO discovery(source,checked_at,error) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error", (source, now, error))
            else:
                db.execute("INSERT INTO discovery VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET checked_at=excluded.checked_at,succeeded_at=excluded.succeeded_at,error=NULL,catalog=excluded.catalog", (source, now, now, None, json.dumps(models)))

    def has_suggestion(self, source, model_id, reason_kind):
        with self.connection() as db:
            for row in db.execute("SELECT body FROM suggestions"):
                body = json.loads(row[0])
                if body.get("source") == source and body.get("model", {}).get("id") == model_id and body.get("reason_kind") == reason_kind:
                    return True
            return False

    def add_suggestion(self, model, reason, source=None, reason_kind=None):
        with self.connection(write=True) as db:
            sid = uuid.uuid4().hex
            body = {"model": model, "reason": reason, "title": model.get("label", model["id"]), "source": source, "reason_kind": reason_kind}
            db.execute("INSERT INTO suggestions VALUES(?,?,?,?)", (sid, json.dumps(body), "pending", self.clock().isoformat()))
            self.event(db, "suggestion.created", {"id": sid, **body})
            return sid

    def decide_suggestion(self, sid, action, expected):
        if action not in ("accept", "reject"):
            raise Rejected("action must be accept or reject")
        with self.connection(write=True) as db:
            policy = self.policy(db)
            if policy["version"] != expected:
                raise Rejected("policy version conflict", 409)
            row = db.execute("SELECT * FROM suggestions WHERE id=?", (sid,)).fetchone()
            if not row:
                raise Rejected("suggestion not found", 404)
            body = json.loads(row["body"])
            db.execute("UPDATE suggestions SET status=? WHERE id=?", (action + "ed" if action == "reject" else "accepted", sid))
            self.event(db, "suggestion." + action, {"id": sid})
            return {"suggestion": {"id": sid, **body, "status": "accepted" if action == "accept" else "rejected"},
                    "policy": policy, "proposed_policy": propose(policy, body) if action == "accept" else None}
