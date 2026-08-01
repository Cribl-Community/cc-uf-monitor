import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Divider, EmptyState, Menu, Modal, Skeleton, Spinner, Switch, TabNav, Tag, Text, Toast } from '@capra/core';
import { ChevronDown, DeleteOutlined, Download, HelpOutlined, MonitoringOutlined, PowerOffOutlined, ReloadOutlined, Terminal } from '@capra/icons';
import logoUrl from './assets/logo.svg';
import './App.css';

declare const CRIBL_API_URL: string;

const DEBUG_DURATION_MS = 15 * 60 * 1000;

// --- KV storage schema ---------------------------------------------------
// v1.0: one monolithic JSON blob at `uf_monitor/forwarders`, each record
//       carrying its full `last_event_raw` payload.
// v1.1: same monolithic blob, but with `last_event_raw` stripped per record.
// v2.0: one record PER forwarder at `uf_monitor/fwd/{id}`, plus a
//       `uf_monitor/schema_version` marker. Per-forwarder keys mean a write
//       only touches the one forwarder it changes, so concurrent monitoring
//       sessions can no longer clobber each other's records (issue #6).
const CURRENT_SCHEMA_VERSION = '2.0';
// Legacy monolithic key (v1.0/v1.1) — read once during migration, then left
// in place as a rollback backstop.
const KV_LEGACY_STATE_KEY = 'uf_monitor/forwarders';
const KV_SCHEMA_VERSION_KEY = 'uf_monitor/schema_version';
// Prefix under which each forwarder gets its own key: `uf_monitor/fwd/{id}`.
const KV_FWD_PREFIX = 'uf_monitor/fwd/';

// A forwarder id can contain characters that aren't safe in a KV key path
// (dots, slashes, spaces). encodeURIComponent keeps the mapping reversible.
const fwdKey = (forwarder: string) => `${KV_FWD_PREFIX}${encodeURIComponent(forwarder)}`;

// How often to re-read logs and refresh the table while a session is active.
const POLL_INTERVAL_MS = 5000;

// Logger channel for the Splunk TCP "forwarders" input — this is the channel
// Cribl uses to log UF connection events at debug level.
const SPLUNK_LOGGER_ID = 'input:in_splunk_tcp:forwarders';

// Cribl product that owns the worker groups we operate on. We filter the group
// list to non-edge Worker Groups (see fetchGroups), which are Stream groups.
const PRODUCT = 'stream';

type UfRecord = {
  forwarder: string;
  // Origin: the worker group this forwarder was last seen in. Recorded so the
  // global inventory (which spans every monitored group) tracks provenance.
  worker_group: string;
  ip_port: string;
  last_seen: string;
  suf_os: string;
  suf_arch: string;
  s2s_version: string;
  suf_version: string;
  // Internal bookkeeping: total number of log events attributed to this
  // forwarder across all reconcile runs.
  seen_count: number;
  // Raw JSON of the most-recent log event for this forwarder — used to
  // inspect the real field structure and drive correct parsing. LIVE-ONLY:
  // held in the in-memory `forwarders` state to power the Monitor raw-event
  // view, but stripped before persisting (see stripRawRecord) so the KV
  // inventory stays small at large fleet sizes (a raw event is ~1 KB/forwarder).
  last_event_raw?: string;
  // When true, the forwarder is excluded from the Monitor table and CSV export.
  // Toggled per-row on the Inventory page; persisted in KV.
  hidden?: boolean;
  status?: 'new' | 'updated' | 'unchanged';
};

type UfState = Record<string, UfRecord>;

type AppPhase =
  | 'idle'
  | 'activating'
  | 'active'
  | 'searching'
  | 'reconciling'
  | 'done'
  | 'error';

// Read the body as text first, then parse. A blank body (e.g. 204 from deploy)
// or a non-JSON body returns null instead of throwing the opaque
// "ReadableStreamDefaultController ... not valid JSON" proxy error.
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${CRIBL_API_URL}${path}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return readJson(res);
}

async function apiPatch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${CRIBL_API_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`PATCH ${path} → ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return readJson(res);
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${CRIBL_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`POST ${path} → ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return readJson(res);
}

async function kvGet(key: string): Promise<unknown> {
  const res = await fetch(`${CRIBL_API_URL}/kvstore/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`KV get ${key} → ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return readJson(res);
}

async function kvPut(key: string, value: unknown): Promise<void> {
  // Store the JSON as an opaque string with text/plain. With
  // Content-Type: application/json the KV proxy parses the body into an object
  // and persists String(object) → the literal "[object Object]" (confirmed via
  // the KV diagnostics readout). text/plain keeps the JSON text verbatim so the
  // GET round-trips back to the same object.
  const res = await fetch(`${CRIBL_API_URL}/kvstore/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`KV put ${key} → ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
}

// Diagnostic: fetch the raw KV response so we can see EXACTLY what the store
// holds under a key (status + verbatim body), instead of guessing why a
// read-back looks empty. Never throws — returns the observation.
async function kvGetRaw(key: string): Promise<{ status: number; ok: boolean; body: string }> {
  try {
    const res = await fetch(`${CRIBL_API_URL}/kvstore/${key}`);
    const body = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    return { status: -1, ok: false, body: String(e) };
  }
}

async function kvDelete(key: string): Promise<void> {
  const res = await fetch(`${CRIBL_API_URL}/kvstore/${key}`, { method: 'DELETE' });
  // 404 is fine — the key is already gone, which is the desired end state.
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => '');
    throw new Error(`KV delete ${key} → ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
}

// List all KV keys under a prefix via POST /kvstore/keys (see AGENTS.md). The
// proxy returns the matching key names; response shape varies, so accept either
// a bare array or a wrapped `{items|keys}` array.
async function kvListKeys(prefix: string): Promise<string[]> {
  const res = await fetch(`${CRIBL_API_URL}/kvstore/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`KV list keys "${prefix}" → ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  const data = await readJson(res);
  const arr = Array.isArray(data)
    ? data
    : ((data as { items?: unknown; keys?: unknown })?.items ?? (data as { keys?: unknown })?.keys);
  return Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : [];
}

async function fetchGroups(): Promise<string[]> {
  const data = await apiGet('/master/groups') as {
    items: { id: string; type?: string; isFleet?: boolean }[]
  };
  return (data.items ?? [])
    // Exclude Edge Fleets — they aren't real Stream Worker Groups
    .filter(g => g.type !== 'edge' && !g.isFleet)
    .map(g => g.id)
    .filter(Boolean);
}

// Mirrors the working `set_splunk_fwd_logs_to_debug` REST collector exactly:
//   PATCH /m/{group}/system/logger   (the collection endpoint, NOT /system/logger/{id})
//   body: { channels: [{ id: "input:in_splunk_tcp:forwarders", level, ttl }] }
// `ttl` is an ABSOLUTE expiry as epoch MILLISECONDS — the collector sends
// `Date.now() + 60*20*1000`. durationMs is the window; omit it to clear the TTL.
async function setGroupLogLevel(groupId: string, level: string, durationMs?: number): Promise<void> {
  const channel: Record<string, unknown> = { id: SPLUNK_LOGGER_ID, level };
  if (durationMs !== undefined) channel.ttl = Date.now() + durationMs;
  await apiPatch(`/m/${groupId}/system/logger`, {
    channels: [channel],
  });
}

// Read the current logger config for the group and report whether our channel
// is already at DEBUG with a TTL still in the future. `ttl` is an absolute epoch
// (ms) expiry; some builds report it in seconds, so normalize either way.
// Returns null when DEBUG isn't active (no channel, wrong level, or expired TTL).
async function getActiveDebug(groupId: string): Promise<{ expiresAtMs: number } | null> {
  const data = await apiGet(`/m/${groupId}/system/logger`) as {
    items?: { channels?: { id?: string; level?: string; ttl?: number }[] }[];
    channels?: { id?: string; level?: string; ttl?: number }[];
  };
  const channels = data.items?.[0]?.channels ?? data.channels ?? [];
  const ch = channels.find(c => c.id === SPLUNK_LOGGER_ID);
  if (!ch || ch.level !== 'debug' || typeof ch.ttl !== 'number') return null;

  // Normalize: values below ~10^12 are almost certainly epoch seconds.
  const expiresAtMs = ch.ttl < 1e12 ? ch.ttl * 1000 : ch.ttl;
  if (expiresAtMs <= Date.now()) return null; // already expired
  return { expiresAtMs };
}

// Return the list of files with pending (uncommitted) changes in the group's working tree.
async function pendingFiles(groupId: string): Promise<string[]> {
  const data = await apiGet(`/m/${groupId}/version/status`) as {
    items?: { files?: { path: string }[]; modified?: string[] }[]
  };
  const item = data.items?.[0];
  const paths = [
    ...(item?.files?.map(f => f.path) ?? []),
    ...(item?.modified ?? []),
  ];
  return [...new Set(paths.filter(Boolean))];
}

// Of the pending files, pick the logger config file(s) — the ones our PATCH writes.
// This is robust when the logger file was already dirty from a prior run (a plain
// before/after diff would miss it), while still excluding unrelated pending edits.
function loggerConfigFiles(files: string[]): string[] {
  return files.filter(f => /(^|\/)logger\.yml$/.test(f) || /\/logger\//.test(f));
}

// Commit only the given files to the group's effective config and deploy that commit —
// leaving any other pending edits in the working tree untouched.
async function commitAndDeploy(groupId: string, files: string[], message: string): Promise<string> {
  const commitRes = await apiPost(`/m/${groupId}/version/commit`, {
    message,
    effective: true,
    files,
  }) as { items?: { commit?: string }[] };
  const hash = commitRes.items?.[0]?.commit;
  if (!hash) throw new Error('Commit succeeded but no commit hash was returned.');

  await apiPatch(`/products/${PRODUCT}/groups/${encodeURIComponent(groupId)}/deploy`, { version: hash });
  return hash;
}

async function fetchLogsForUFs(groupId: string, earliestSec: number): Promise<UfRecord[]> {
  // The `filter` param is a JS expression evaluated per-event server-side. We
  // MUST filter server-side: the result is capped at 1000 events, and the group
  // logs are dominated by internal stats spam (channel:"server"/"ProcessMetrics").
  // Without this, the 1000 fills with noise and real forwarder events fall off
  // the window (the "sliding" counts). Restrict to the forwarders debug channel;
  // version-presence is enforced client-side below (raw events may lack `version`
  // as a top-level field the expression can reference).
  const filter = `channel=='${SPLUNK_LOGGER_ID}' && level=='debug' && _raw.includes('version')`;
  const params = new URLSearchParams({
    type: 'group',
    groupId,
    et: String(earliestSec),
    limit: '1000', // server-enforced maximum
    filter,
  });
  const data = await apiGet(`/system/logs/search?${params}`) as {
    items?: { events?: Record<string, unknown>[] }[]
  };
  const events = data.items?.flatMap(i => i.events ?? []) ?? [];

  // Field names come from the forwarders debug channel (per the reference search):
  //   hostname, src, os, arch, s2sVersion, version, plus channel/level/time.
  // Read structured fields directly; fall back to key=value in the message string
  // in case the raw (unparsed) event only carries them inline.
  const ufMap: Record<string, UfRecord> = {};
  for (const ev of events) {
    const msg = str(ev.message ?? ev.msg ?? ev._raw);

    // Match the reference filter: debug level, the forwarders channel, version present.
    const level = str(ev.level) || extractField(msg, 'level');
    const channel = str(ev.channel) || extractField(msg, 'channel');
    if (level && level !== 'debug') continue;
    if (channel && channel !== SPLUNK_LOGGER_ID) continue;

    // Count/show ONLY events that carry a version field in the raw JSON. This
    // is what distinguishes a UF connection log from internal stats spam
    // (channel:"server"/"ProcessMetrics" events have no version).
    const suf_version = 'version' in ev ? str(ev.version) : extractField(msg, 'version') || '';
    if (!suf_version) continue;

    const forwarder = str(ev.hostname) || extractField(msg, 'hostname') || str(ev.host) || '';
    if (!forwarder) continue;

    const ip_port = str(ev.src) || extractField(msg, 'src') || '';
    const suf_os = str(ev.os) || extractField(msg, 'os') || '';
    const suf_arch = str(ev.arch) || extractField(msg, 'arch') || '';
    const s2s_version = str(ev.s2sVersion) || extractField(msg, 's2sVersion') || '';
    const ts = str(ev.time ?? ev._time ?? ev.timestamp);
    const raw = JSON.stringify(ev);

    const prev = ufMap[forwarder];
    // aggregate by forwarder: bump the per-batch seen count, and keep the
    // identity fields from the most-recent event (largest timestamp)
    if (!prev) {
      ufMap[forwarder] = { forwarder, worker_group: groupId, ip_port, last_seen: ts, suf_os, suf_arch, s2s_version, suf_version, seen_count: 1, last_event_raw: raw };
    } else {
      prev.seen_count += 1;
      if (ts > prev.last_seen) {
        prev.worker_group = groupId;
        prev.ip_port = ip_port;
        prev.last_seen = ts;
        prev.suf_os = suf_os;
        prev.suf_arch = suf_arch;
        prev.s2s_version = s2s_version;
        prev.suf_version = suf_version;
        prev.last_event_raw = raw;
      }
    }
  }
  return Object.values(ufMap);
}

// Coerce an unknown event field to a trimmed string ('' when absent).
function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function extractField(msg: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(msg);
  return m?.[1];
}

function reconcile(stored: UfState, fresh: UfRecord[]): { merged: UfState; newCount: number; updatedCount: number } {
  const merged: UfState = { ...stored };
  let newCount = 0;
  let updatedCount = 0;

  for (const rec of fresh) {
    const existing = stored[rec.forwarder];
    if (!existing) {
      merged[rec.forwarder] = { ...rec, status: 'new' };
      newCount++;
    } else {
      const changed =
        existing.ip_port !== rec.ip_port ||
        existing.suf_os !== rec.suf_os ||
        existing.suf_arch !== rec.suf_arch ||
        existing.s2s_version !== rec.s2s_version ||
        existing.suf_version !== rec.suf_version;
      // accumulate the lifetime seen count across runs
      const seen_count = (existing.seen_count ?? 0) + rec.seen_count;
      // Preserve the user's hidden flag — a fresh event must not un-hide a row.
      merged[rec.forwarder] = { ...rec, seen_count, hidden: existing.hidden, status: changed ? 'updated' : 'unchanged' };
      if (changed) updatedCount++;
    }
  }

  for (const key of Object.keys(stored)) {
    if (!merged[key] || merged[key].status === undefined) {
      merged[key] = { ...stored[key], status: 'unchanged' };
    }
  }

  return { merged, newCount, updatedCount };
}

// Produce a KV-safe copy of a record: drop the heavy, live-only
// `last_event_raw`. Persisting one raw event (~1 KB) per forwarder would bloat
// storage needlessly; the raw event is only needed transiently for the Monitor
// view, so it never leaves in-memory state. Also drop the live-only `status`.
function stripRawRecord({ last_event_raw: _r, status: _s, ...rest }: UfRecord): UfRecord {
  return rest;
}

// --- v2.0 inventory access layer -----------------------------------------
// The inventory is stored as one KV key per forwarder (`uf_monitor/fwd/{id}`).
// Every mutation touches only the affected forwarder's key, so overlapping
// monitoring sessions can't clobber each other's records (issue #6).

// Persist a single forwarder (raw/status stripped). Idempotent per key.
async function saveForwarder(rec: UfRecord): Promise<void> {
  await kvPut(fwdKey(rec.forwarder), stripRawRecord(rec));
}

// Remove a single forwarder's key.
async function removeForwarder(forwarder: string): Promise<void> {
  await kvDelete(fwdKey(forwarder));
}

// Read the whole inventory: list every per-forwarder key, fetch them, and
// assemble a UfState keyed by forwarder. Runs the one-time migration first.
async function loadInventory(): Promise<UfState> {
  await ensureSchemaMigrated();
  const keys = await kvListKeys(KV_FWD_PREFIX);
  const state: UfState = {};
  await Promise.all(keys.map(async (key) => {
    const raw = await kvGetRaw(key);
    if (!raw.ok || !raw.body) return;
    try {
      const rec = JSON.parse(raw.body) as UfRecord;
      if (rec && typeof rec.forwarder === 'string') state[rec.forwarder] = rec;
    } catch {
      // Skip an unparseable record rather than fail the whole load.
    }
  }));
  return state;
}

// One-time, idempotent migration to schema v2.0. Memoized so concurrent
// callers (e.g. Monitor hydrate + Inventory load racing on mount) share a
// single run. If already at v2.0, does nothing. Otherwise reads the legacy
// monolithic blob (v1.0 with raw, or v1.1 without), fans each record out to its
// own `uf_monitor/fwd/{id}` key, and stamps the schema marker. The legacy key
// is intentionally left in place as a rollback backstop.
let migrationPromise: Promise<void> | null = null;
async function ensureSchemaMigrated(): Promise<void> {
  // On failure, clear the memo so a later load can retry rather than being
  // stuck with a poisoned rejected promise for the page's lifetime.
  if (!migrationPromise) {
    migrationPromise = runMigration().catch((e) => {
      migrationPromise = null;
      throw e;
    });
  }
  return migrationPromise;
}

async function runMigration(): Promise<void> {
  const marker = await kvGet(KV_SCHEMA_VERSION_KEY) as { version?: string } | null;
  if (marker?.version === CURRENT_SCHEMA_VERSION) return;

  // Read the legacy monolithic blob. Absent (fresh install) → nothing to move.
  const legacyRaw = await kvGetRaw(KV_LEGACY_STATE_KEY);
  if (legacyRaw.ok && legacyRaw.body) {
    let legacy: UfState = {};
    try { legacy = (JSON.parse(legacyRaw.body) as UfState) ?? {}; } catch { legacy = {}; }
    // Fan out each record to its own key (stripRawRecord handles a v1.0 blob
    // that still carries last_event_raw, so the result is uniform v1.1 shape).
    await Promise.all(
      Object.values(legacy)
        .filter((rec) => rec && typeof rec.forwarder === 'string')
        .map((rec) => saveForwarder(rec)),
    );
  }

  // Stamp the schema marker last, so an interrupted migration re-runs (the
  // per-key writes above are idempotent, so re-running is safe).
  await kvPut(KV_SCHEMA_VERSION_KEY, { version: CURRENT_SCHEMA_VERSION });
}

function statusColor(s: UfRecord['status']): 'success' | 'info' | 'default' {
  if (s === 'new') return 'success';
  if (s === 'updated') return 'info';
  return 'default';
}

// Serialize forwarders to CSV. Columns mirror the Saved table (incl. Origin).
// Each field is quoted and embedded quotes are doubled per RFC 4180.
function toCsv(records: UfRecord[]): string {
  const cols: { header: string; get: (r: UfRecord) => string }[] = [
    { header: 'forwarder', get: r => r.forwarder },
    { header: 'worker_group', get: r => r.worker_group ?? '' },
    { header: 'ip_port', get: r => r.ip_port },
    { header: 'last_seen', get: r => r.last_seen },
    { header: 'suf_os', get: r => r.suf_os },
    { header: 'suf_arch', get: r => r.suf_arch },
    { header: 's2s_version', get: r => r.s2s_version },
    { header: 'suf_version', get: r => r.suf_version },
    { header: 'total_seen', get: r => String(r.seen_count) },
  ];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [cols.map(c => esc(c.header)).join(',')];
  for (const r of records) lines.push(cols.map(c => esc(c.get(r))).join(','));
  return lines.join('\r\n');
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function App() {
  const [phase, setPhase] = useState<AppPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [forwarders, setForwarders] = useState<UfRecord[]>([]);
  // True until the initial KV hydration of the Monitor table completes.
  const [monitorHydrating, setMonitorHydrating] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [updatedCount, setUpdatedCount] = useState(0);
  const [remainingMs, setRemainingMs] = useState(DEBUG_DURATION_MS);
  const [showConfirm, setShowConfirm] = useState(false);

  const [groups, setGroups] = useState<string[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState('');

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  // Count of consecutive failed polls, so we warn once per outage streak
  // (not every 5s) and confirm when polling recovers.
  const pollFailStreakRef = useRef(0);
  // Frozen snapshot of KV state at session start. Each poll re-reads the FULL
  // debug window, so we always reconcile fresh results against this baseline
  // (never against the previous poll) to keep seen_count idempotent.
  const baselineRef = useRef<UfState>({});
  // true while actively polling; Stop flips this off but leaves DEBUG running.
  const [collecting, setCollecting] = useState(false);
  // Details of the running debug session, so "Resume watching" can restart
  // polling against the same window while the countdown is still going.
  const sessionRef = useRef<{ groupId: string; startedAtSec: number } | null>(null);
  // True when a pre-existing DEBUG window was detected on group select and the
  // countdown was adopted, but the user hasn't started watching yet.
  const [adopted, setAdopted] = useState(false);
  // Absolute expiry (epoch ms) of a detected pre-existing DEBUG window.
  const adoptExpiryRef = useRef<number>(0);
  // Checking a group's current logger config right after selection.
  const [checkingDebug, setCheckingDebug] = useState(false);

  const [groupsError, setGroupsError] = useState<string | null>(null);

  // Which page/tab is showing.
  const [tab, setTab] = useState<'monitor' | 'saved' | 'help'>('monitor');
  // Forwarders loaded from the KV store (the persisted inventory).
  const [saved, setSaved] = useState<UfRecord[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  // Forwarder awaiting delete confirmation (null = no dialog open).
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Whether the "Most recent event per forwarder" raw-event table is shown.
  // Collapsed by default — it's a developer/diagnostic view of the verbatim JSON.
  const [showRawEvents, setShowRawEvents] = useState(false);

  useEffect(() => {
    fetchGroups()
      .then(ids => { setGroups(ids); setGroupsLoading(false); })
      .catch(e => { setGroupsError(String(e)); setGroupsLoading(false); });
  }, []);

  // Hydrate the Monitor table from the persisted KV inventory on mount, so the
  // app never opens to a blank Monitor when forwarders are already known. A live
  // DEBUG session then overlays new/updated status on top of these rows. Statuses
  // aren't persisted, so hydrated rows start with no status badge.
  useEffect(() => {
    void (async () => {
      try {
        const stored = await loadInventory();
        const rows = Object.values(stored)
          .map(r => ({ ...r, status: undefined }))
          .sort((a, b) => a.forwarder.localeCompare(b.forwarder));
        setForwarders(rows);
      } catch {
        // Non-fatal: an empty/unparseable inventory just leaves Monitor empty.
      } finally {
        setMonitorHydrating(false);
      }
    })();
  }, []);

  const loadSaved = useCallback(async () => {
    setSavedLoading(true);
    try {
      const stored = await loadInventory();
      setSaved(Object.values(stored).sort((a, b) => a.forwarder.localeCompare(b.forwarder)));
    } catch (e) {
      Toast.error(`Failed to load saved forwarders: ${String(e)}`);
    } finally {
      setSavedLoading(false);
    }
  }, []);

  // Load the saved inventory whenever the Saved tab is opened.
  useEffect(() => {
    if (tab === 'saved') void loadSaved();
  }, [tab, loadSaved]);

  const deleteSaved = useCallback(async (forwarder: string) => {
    try {
      // Delete just this forwarder's key — no read-modify-write of a shared
      // blob, so a concurrent poll can't overwrite the deletion.
      await removeForwarder(forwarder);
      setSaved(prev => prev.filter(uf => uf.forwarder !== forwarder));
      // Also drop it from the frozen baseline + live rows, so an in-flight
      // session's next poll doesn't resurrect it with its old accumulated count
      // (reconcile treats a forwarder absent from the baseline as brand new).
      delete baselineRef.current[forwarder];
      setForwarders(prev => prev.filter(uf => uf.forwarder !== forwarder));
      Toast.success(`Removed "${forwarder}" from saved forwarders.`);
    } catch (e) {
      Toast.error(`Failed to delete "${forwarder}": ${String(e)}`);
    }
  }, []);

  // Show/Hide a forwarder. Persists to KV and also updates the frozen baseline
  // + live Monitor rows so an in-flight session's next poll doesn't revert it
  // (reconcile preserves the stored `hidden` flag).
  const toggleHidden = useCallback(async (forwarder: string, hidden: boolean) => {
    try {
      // Read just this forwarder's current record, flip the flag, write it back.
      const current = await kvGet(fwdKey(forwarder)) as UfRecord | null;
      if (!current) return;
      const updated = { ...current, hidden };
      await saveForwarder(updated);
      setSaved(prev => prev.map(uf => uf.forwarder === forwarder ? { ...uf, hidden } : uf));
      // Keep the running session consistent with the new flag.
      if (baselineRef.current[forwarder]) baselineRef.current[forwarder].hidden = hidden;
      setForwarders(prev => prev.map(uf => uf.forwarder === forwarder ? { ...uf, hidden } : uf));
      Toast.success(`"${forwarder}" is now ${hidden ? 'hidden' : 'shown'}.`);
    } catch (e) {
      Toast.error(`Failed to update "${forwarder}": ${String(e)}`);
    }
  }, []);

  // Export the visible (non-hidden) inventory as a CSV download.
  const downloadCsv = useCallback(() => {
    const visible = saved.filter(uf => !uf.hidden);
    if (visible.length === 0) {
      Toast.warning('No visible forwarders to export.');
      return;
    }
    const csv = toCsv(visible);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'uf_monitor_forwarders.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    Toast.success(`Exported ${visible.length} forwarder${visible.length === 1 ? '' : 's'} to CSV.`);
  }, [saved]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setCollecting(false);
  }, []);

  const clearTimers = () => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  useEffect(() => () => clearTimers(), []);

  // One reconcile pass: re-read the full window and merge against the frozen
  // baseline, then refresh the table live. Safe to call repeatedly.
  const pollOnce = useCallback(async (groupId: string, startedAtSec: number) => {
    if (pollInFlightRef.current) return; // don't overlap slow polls
    pollInFlightRef.current = true;
    try {
      const fresh = await fetchLogsForUFs(groupId, startedAtSec);
      const { merged, newCount: nc, updatedCount: uc } = reconcile(baselineRef.current, fresh);
      // Persist only the forwarders that appeared in THIS poll, each to its own
      // key. Untouched forwarders (baseline-only) aren't rewritten, so another
      // session monitoring a different group can't have its records clobbered.
      await Promise.all(fresh.map(f => saveForwarder(merged[f.forwarder])));
      const rows = Object.values(merged).sort((a, b) => a.forwarder.localeCompare(b.forwarder));
      setForwarders(rows);
      setNewCount(nc);
      setUpdatedCount(uc);
      // Recovered after one or more failures — let the user know polling is healthy again.
      if (pollFailStreakRef.current > 0) {
        pollFailStreakRef.current = 0;
        Toast.info('Log polling recovered.');
      }
    } catch (e) {
      // Transient poll failures shouldn't tear down the session. Warn only on the
      // first failure of a streak so a flaky network doesn't spam a toast every 5s.
      pollFailStreakRef.current += 1;
      if (pollFailStreakRef.current === 1) {
        Toast.warning(`Log poll failed (will keep retrying): ${String(e)}`);
      }
    } finally {
      pollInFlightRef.current = false;
    }
  }, []);

  const startPolling = useCallback((groupId: string, startedAtSec: number) => {
    if (pollRef.current) return;
    setCollecting(true);
    setPhase('searching');
    void pollOnce(groupId, startedAtSec); // immediate first pass
    pollRef.current = setInterval(() => {
      void pollOnce(groupId, startedAtSec);
    }, POLL_INTERVAL_MS);
  }, [pollOnce]);

  // Drive an active DEBUG window: freeze the KV baseline, start polling, run the
  // countdown to `expiresAtMs`, and schedule the end-of-window handler. The DEBUG
  // log level always carries a TTL, so it reverts on its own when the window ends —
  // the app never patches config back, whether it started the window or adopted one.
  const beginSession = useCallback(async (groupId: string, expiresAtMs: number) => {
    setAdopted(false);

    // Freeze the baseline once, so every poll reconciles against the same start state.
    baselineRef.current = await loadInventory();

    // Read logs from the start of the debug window (or now, whichever is later),
    // capped at the max search window we support.
    const windowStartMs = Math.max(Date.now() - DEBUG_DURATION_MS, expiresAtMs - DEBUG_DURATION_MS);
    const startedAtSec = Math.floor(windowStartMs / 1000);
    sessionRef.current = { groupId, startedAtSec };
    setRemainingMs(Math.max(0, expiresAtMs - Date.now()));
    setPhase('active');

    // Begin live polling immediately; the table updates as events stream in.
    startPolling(groupId, startedAtSec);

    countdownRef.current = setInterval(() => {
      setRemainingMs(Math.max(0, expiresAtMs - Date.now()));
    }, 1000);

    revertTimerRef.current = setTimeout(() => {
      clearInterval(countdownRef.current!);
      setRemainingMs(0);
      stopPolling();
      setPhase('done');
      // The logger entry's TTL reverts DEBUG on its own at the end of the window —
      // we don't patch the config back.
      Toast.info('DEBUG window ended; log level reverts automatically on TTL expiry.');
    }, Math.max(0, expiresAtMs - Date.now()));
  }, [startPolling, stopPolling]);

  const startDebugSession = useCallback(async () => {
    const groupId = selectedGroup;
    if (!groupId) return;
    setPhase('activating');
    setError(null);

    try {
      await setGroupLogLevel(groupId, 'debug', DEBUG_DURATION_MS);
      // Commit ONLY the logger config file — robust even if it was already dirty
      // from a prior run (a before/after diff would miss it), while still leaving
      // any unrelated pending edits an operator has in flight untouched.
      const changed = loggerConfigFiles(await pendingFiles(groupId));

      if (changed.length === 0) {
        throw new Error('Logger PATCH produced no pending logger config file to commit — nothing to deploy.');
      }
      await commitAndDeploy(groupId, changed, `UF Monitor: set ${SPLUNK_LOGGER_ID} to DEBUG (15 min)`);
      Toast.success(`Committed & deployed to "${groupId}": ${changed.join(', ')}`);
      Toast.success(`Log level set to DEBUG on group "${groupId}". Active for 15 minutes.`);

      await beginSession(groupId, Date.now() + DEBUG_DURATION_MS);
    } catch (e) {
      setError(String(e));
      setPhase('error');
      Toast.error(`Failed to activate debug mode: ${String(e)}`);
    }
  }, [selectedGroup, beginSession]);

  // Adopt a pre-existing DEBUG window: start watching against the remaining TTL
  // without changing config (we didn't enable it, so we won't revert it).
  const startWatchingAdopted = useCallback(async () => {
    const groupId = selectedGroup;
    const expiresAtMs = adoptExpiryRef.current;
    if (!groupId || !expiresAtMs || expiresAtMs <= Date.now()) return;
    setError(null);
    try {
      await beginSession(groupId, expiresAtMs);
      Toast.info('Watching the DEBUG window already active on this group.');
    } catch (e) {
      setError(String(e));
      setPhase('error');
      Toast.error(`Failed to start watching: ${String(e)}`);
    }
  }, [selectedGroup, beginSession]);

  // Select a worker group and probe its logger config: if DEBUG is already
  // active on our channel, adopt the remaining TTL and offer "Start watching"
  // instead of re-enabling. GET only — no config change, so no confirmation.
  const selectGroup = useCallback(async (g: string) => {
    setSelectedGroup(g);
    setAdopted(false);
    adoptExpiryRef.current = 0;
    setCheckingDebug(true);
    try {
      const active = await getActiveDebug(g);
      if (active) {
        adoptExpiryRef.current = active.expiresAtMs;
        setRemainingMs(Math.max(0, active.expiresAtMs - Date.now()));
        setAdopted(true);
      }
    } catch {
      // Non-fatal: if the probe fails, fall back to the normal enable flow.
    } finally {
      setCheckingDebug(false);
    }
  }, []);

  // Stop collecting log data, but leave the DEBUG log level (and its countdown /
  // scheduled revert) running so the config stays in debug for the full window.
  const stopCollecting = useCallback(() => {
    stopPolling();
    Toast.info('Stopped watching. DEBUG log level remains active until the timer ends.');
  }, [stopPolling]);

  // Resume polling for the current session (only meaningful while the countdown
  // is still running — the button is gated on remainingMs > 0 in the UI).
  const resumeWatching = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    startPolling(s.groupId, s.startedAtSec);
    Toast.info('Resumed watching.');
  }, [startPolling]);

  const isActive = phase === 'active' || phase === 'searching' || phase === 'reconciling';
  const canStart = (phase === 'idle' || phase === 'done' || phase === 'error') && !!selectedGroup;

  // Monitor table + CSV export show only non-hidden forwarders. The full set
  // (including hidden) still lives in `forwarders`/KV and on the Saved page.
  const visibleForwarders = forwarders.filter(uf => !uf.hidden);

  return (
    <>
      <Toast.Provider />
      <div className="app">
        <div className="app-header">
          <div className="app-title-row">
            <img src={logoUrl} alt="UF Monitor" className="app-logo" width={28} height={28} />
            <div className="app-title-text">
              <Text as="h1" variant="heading-md">UF Monitor</Text>
              <Text variant="body-sm-normal" as="p">
                Splunk Universal Forwarder inventory for Cribl · target source <code>{SPLUNK_LOGGER_ID}</code>
              </Text>
            </div>
          </div>
        </div>

        <Divider type="horizontal" />

        <TabNav
          activeKey={tab}
          onTabClick={(key, e) => { e.preventDefault(); setTab(key as 'monitor' | 'saved' | 'help'); }}
          items={[
            { key: 'monitor', name: 'Monitor', href: '#monitor' },
            { key: 'saved', name: 'Inventory', href: '#saved' },
            { key: 'help', name: 'Help', href: '#help' },
          ]}
        />

        {tab === 'monitor' && (
        <>
        <Alert
          appearance="info"
          layout="inline"
          title="How this works"
          action={{ label: 'Read the full guide', onClick: () => setTab('help') }}
        >
          Splunk Universal Forwarder information isn&apos;t captured in a default configuration. This app briefly
          raises the <code>{SPLUNK_LOGGER_ID}</code> input logger to <strong>DEBUG</strong> on the
          selected worker group (auto-reverting after 15 minutes), reads the resulting connection
          events, and builds a persistent inventory of every forwarder — OS, architecture, S2S
          protocol, and UF version.
        </Alert>

        <div className="group-selector">
          <Text as="label" variant="body-sm-semibold">Worker Group</Text>
          {groupsLoading ? (
            <Skeleton loading active title paragraph={false} />
          ) : groupsError ? (
            <Alert appearance="danger" layout="section" title="Failed to load worker groups">
              {groupsError}
            </Alert>
          ) : (
            <Menu
              trigger={
                <Button
                  variant="secondary"
                  trailingIcon={ChevronDown}
                  disabled={isActive || phase === 'activating'}
                >
                  {selectedGroup || `Select a worker group (${groups.length})`}
                </Button>
              }
            >
              {groups.map(g => (
                <Menu.Item
                  key={g}
                  label={g}
                  active={g === selectedGroup}
                  onPress={() => void selectGroup(g)}
                />
              ))}
            </Menu>
          )}
        </div>

        <div className="controls-row">
          {checkingDebug && (
            <div className="status-row">
              <Spinner size="sm" />
              <Text variant="body-sm-normal">Checking current DEBUG state…</Text>
            </div>
          )}

          {(phase === 'idle' || phase === 'done' || phase === 'error') && !checkingDebug && (
            adopted && adoptExpiryRef.current > Date.now() ? (
              <>
                <div className="status-row">
                  <Text variant="body-sm-normal">
                    {`DEBUG already active on "${selectedGroup}" — ${formatCountdown(remainingMs)} remaining`}
                  </Text>
                </div>
                <Button
                  variant="primary"
                  leadingIcon={MonitoringOutlined}
                  disabled={!selectedGroup}
                  onClick={() => void startWatchingAdopted()}
                >
                  Start watching
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  leadingIcon={Terminal}
                  disabled={!canStart}
                  onClick={() => setShowConfirm(true)}
                >
                  Enable DEBUG (15 min)
                </Button>
                {!selectedGroup && (
                  <Text variant="body-sm-normal">Select a worker group above to begin.</Text>
                )}
              </>
            )
          )}

          {phase === 'activating' && (
            <div className="status-row">
              <Spinner size="sm" />
              <Text variant="body-sm-normal">Activating DEBUG mode…</Text>
            </div>
          )}

          {isActive && (
            <>
              <div className="status-row" aria-live="polite">
                {collecting ? <Spinner size="sm" /> : <Tag color="warning" size="sm">Paused</Tag>}
                <Text variant="body-sm-normal">
                  {`DEBUG active on "${selectedGroup}" — ${formatCountdown(remainingMs)} remaining`}
                </Text>
              </div>
              {collecting ? (
                <Button
                  variant="secondary"
                  leadingIcon={PowerOffOutlined}
                  onClick={stopCollecting}
                >
                  Pause updates
                </Button>
              ) : (
                remainingMs > 0 && (
                  <Button
                    variant="secondary"
                    leadingIcon={ReloadOutlined}
                    onClick={resumeWatching}
                  >
                    Resume updates
                  </Button>
                )
              )}
              <Text variant="body-sm-normal">DEBUG stays on until the timer ends.</Text>
            </>
          )}

          {phase === 'done' && (
            <Button
              variant="secondary"
              leadingIcon={ReloadOutlined}
              onClick={() => setShowConfirm(true)}
            >
              Run again
            </Button>
          )}
        </div>

        {error && (
          <Alert appearance="danger" layout="section" title="Something went wrong">
            {error}
          </Alert>
        )}

        {phase === 'done' && (
          <div className="summary-row">
            <Tag color="success">{`${newCount} new`}</Tag>
            <Tag color="info">{`${updatedCount} updated`}</Tag>
            <Tag color="default">{`${visibleForwarders.length - newCount - updatedCount} unchanged`}</Tag>
          </div>
        )}

        {monitorHydrating ? (
          <Card>
            <Skeleton loading active paragraph={{ rows: 4 }} />
          </Card>
        ) : visibleForwarders.length > 0 ? (
          <Card>
            <div className="table-wrapper">
              <table className="uf-table">
                <caption className="visually-hidden">Discovered Universal Forwarders</caption>
                <thead>
                  <tr>
                    <th scope="col">Forwarder</th>
                    <th scope="col" title="Worker group this forwarder was last seen in">Origin</th>
                    <th scope="col">IP:Port</th>
                    <th scope="col">Last Seen</th>
                    <th scope="col">OS</th>
                    <th scope="col">Arch</th>
                    <th scope="col">S2S</th>
                    <th scope="col">Version</th>
                    <th scope="col" title="Total debug connection logs (channel input:in_splunk_tcp:forwarders, version present) seen for this forwarder over the full window">Total</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleForwarders.map(uf => (
                    <tr key={uf.forwarder}>
                      <td><code>{uf.forwarder}</code></td>
                      <td>{uf.worker_group ? <code>{uf.worker_group}</code> : '—'}</td>
                      <td>{uf.ip_port}</td>
                      <td>{uf.last_seen}</td>
                      <td>{uf.suf_os}</td>
                      <td>{uf.suf_arch}</td>
                      <td>{uf.s2s_version}</td>
                      <td>{uf.suf_version}</td>
                      <td>{uf.seen_count}</td>
                      <td>
                        {uf.status ? (
                          <Tag color={statusColor(uf.status)} size="sm">{uf.status}</Tag>
                        ) : (
                          <Text variant="body-sm-normal">—</Text>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <EmptyState
            illustration="EmptySuitcase"
            title="No forwarders yet"
            description={selectedGroup
              ? `Enable DEBUG on "${selectedGroup}" to discover forwarders connecting to it.`
              : 'Select a worker group and enable DEBUG to build your forwarder inventory.'}
          />
        )}

        {visibleForwarders.some(uf => uf.last_event_raw) && (
          <Collapse
            title="Most recent event per forwarder (debug)"
            isExpanded={showRawEvents}
            onExpandedChange={setShowRawEvents}
          >
            <div className="raw-events">
              <Text variant="body-sm-normal" as="p">
                The most-recent debug event captured for each forwarder, shown verbatim.
              </Text>
              <div className="table-wrapper">
                <table className="uf-table">
                  <caption className="visually-hidden">Most recent raw event per forwarder</caption>
                  <thead>
                    <tr>
                      <th scope="col">Forwarder</th>
                      <th scope="col">Last Seen</th>
                      <th scope="col">Raw event</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleForwarders.filter(uf => uf.last_event_raw).map(uf => (
                      <tr key={uf.forwarder}>
                        <td><code>{uf.forwarder}</code></td>
                        <td>{uf.last_seen}</td>
                        <td><pre className="raw-json">{uf.last_event_raw}</pre></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Collapse>
        )}
        </>
        )}

        {tab === 'saved' && (
          <div className="saved-page">
            <div className="controls-row">
              <Text as="h2" variant="heading-sm">Inventory</Text>
              <div className="controls-row-actions">
                <Button
                  variant="secondary"
                  leadingIcon={ReloadOutlined}
                  onClick={() => void loadSaved()}
                  disabled={savedLoading}
                >
                  Refresh
                </Button>
                <Button
                  variant="primary"
                  leadingIcon={Download}
                  onClick={downloadCsv}
                  disabled={savedLoading || saved.filter(uf => !uf.hidden).length === 0}
                >
                  Download CSV
                </Button>
              </div>
            </div>
            <Text variant="body-sm-normal" as="p">
              A <strong>global</strong> forwarder inventory persisted in the app&apos;s KV store —
              it spans <strong>every worker group</strong> you&apos;ve monitored, not just the one
              currently selected. The <strong>Origin</strong> column shows which worker group each
              forwarder was last seen in. Use the <strong>Visible</strong> toggle to hide a
              forwarder — hidden rows are excluded from the Monitor view and the CSV export (but
              stay saved here). Delete rows you no longer want to track.
            </Text>

            {savedLoading ? (
              <Card>
                <Skeleton loading active paragraph={{ rows: 4 }} />
              </Card>
            ) : saved.length === 0 ? (
              <EmptyState
                illustration="EmptyFolder"
                title="No forwarders saved yet"
                description="Run a monitor session to discover forwarders — they'll be persisted here automatically."
              >
                <Button variant="primary" leadingIcon={MonitoringOutlined} onClick={() => setTab('monitor')}>
                  Go to Monitor
                </Button>
              </EmptyState>
            ) : (
              <Card>
                <div className="table-wrapper">
                  <table className="uf-table">
                    <caption className="visually-hidden">Persisted global forwarder inventory</caption>
                    <thead>
                      <tr>
                        <th scope="col">Forwarder</th>
                        <th scope="col" title="Worker group this forwarder was last seen in">Origin</th>
                        <th scope="col">IP:Port</th>
                        <th scope="col">Last Seen</th>
                        <th scope="col">OS</th>
                        <th scope="col">Arch</th>
                        <th scope="col">S2S</th>
                        <th scope="col">Version</th>
                        <th scope="col" title="Total debug connection logs seen for this forwarder">Total</th>
                        <th scope="col" title="When off, this forwarder is hidden from the Monitor view and CSV export">Visible</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {saved.map(uf => (
                        <tr key={uf.forwarder} className={uf.hidden ? 'row-hidden' : undefined}>
                          <td><code>{uf.forwarder}</code></td>
                          <td>{uf.worker_group ? <code>{uf.worker_group}</code> : '—'}</td>
                          <td>{uf.ip_port}</td>
                          <td>{uf.last_seen}</td>
                          <td>{uf.suf_os}</td>
                          <td>{uf.suf_arch}</td>
                          <td>{uf.s2s_version}</td>
                          <td>{uf.suf_version}</td>
                          <td>{uf.seen_count}</td>
                          <td>
                            <Switch
                              size="sm"
                              aria-label={`Toggle visibility of ${uf.forwarder}`}
                              checked={!uf.hidden}
                              onChange={e => void toggleHidden(uf.forwarder, !e.target.checked)}
                            />
                          </td>
                          <td>
                            <Button
                              variant="tertiary"
                              appearance="danger"
                              size="sm"
                              leadingIcon={DeleteOutlined}
                              aria-label={`Delete ${uf.forwarder}`}
                              onClick={() => setPendingDelete(uf.forwarder)}
                            >
                              Delete
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )}

        {tab === 'help' && (
          <div className="help-page">
            <div className="app-title-row">
              <HelpOutlined size="md" />
              <Text as="h2" variant="heading-sm">About UF Monitor</Text>
            </div>

            <Text variant="body-md-normal" as="p">
              UF Monitor answers a deceptively simple question: <em>which Splunk Universal Forwarders
              (SUFs) are connecting to my Cribl worker group, and what versions are they running?</em>
              Forwarders don&apos;t advertise their version during normal operation — that detail is
              only emitted when the input logger runs at <strong>DEBUG</strong> level. This app
              automates the whole loop safely.
            </Text>

            <Alert appearance="info" layout="section" title="The problem this solves">
              Splunk UF connection metadata (version, OS, architecture, S2S protocol) is logged by the
              <code> {SPLUNK_LOGGER_ID} </code> input channel, but <strong>only at DEBUG level</strong>.
              Leaving that channel at DEBUG permanently is noisy and expensive, so operators normally
              never see this data. UF Monitor turns DEBUG on for a short, self-reverting window, harvests
              the events, and persists a clean inventory — so you get the visibility without the noise.
            </Alert>

            <Text as="h3" variant="heading-sm">What the app does, step by step</Text>
            <ol className="help-steps">
              <li>
                <strong>You pick a worker group.</strong> On selection the app reads the group&apos;s
                current logger config. If DEBUG is <em>already</em> active on the forwarders channel
                (e.g. someone else enabled it), the app adopts the remaining window and offers
                &ldquo;Start watching&rdquo; instead of re-enabling.
              </li>
              <li>
                <strong>You confirm, and the app raises the log level.</strong> It patches
                <code> {SPLUNK_LOGGER_ID} </code> to <strong>DEBUG</strong> with a 15-minute TTL, then
                commits and deploys that change to the group so the worker processes actually pick it up.
              </li>
              <li>
                <strong>It reads the logs live.</strong> Every {POLL_INTERVAL_MS / 1000}s it queries the
                group logs for that channel at DEBUG level, keeping only events that carry a
                <code> version </code> field — the reliable signal of a forwarder reporting its relevant metadata (vs.
                internal stats noise).
              </li>
              <li>
                <strong>It reconciles against saved state.</strong> Each forwarder is matched against the
                KV-persisted inventory and marked <Tag color="success" size="sm">new</Tag>,{' '}
                <Tag color="info" size="sm">updated</Tag>, or <Tag color="default" size="sm">unchanged</Tag>.
              </li>
              <li>
                <strong>It reverts automatically.</strong> The DEBUG log level is set with a TTL, so it
                expires on its own when the window ends — the app doesn&apos;t patch the config back. A
                window it merely adopted is likewise left to its own TTL.
              </li>
            </ol>

            <Alert appearance="warning" layout="section" title="Good to know">
              DEBUG logging on this channel is self-service and safe for short windows; Cribl caps a
              debug TTL at 24 hours in cloud environments. UF Monitor uses a conservative 15-minute
              window. The forwarder inventory is <strong>global</strong> — one KV record keyed by
              hostname, accumulated across every worker group you monitor.
            </Alert>

            <Text as="h3" variant="heading-sm">Fields collected</Text>
            <div className="table-wrapper">
              <table className="uf-table">
                <thead>
                  <tr><th>Column</th><th>Meaning</th></tr>
                </thead>
                <tbody>
                  <tr><td><code>Forwarder</code></td><td>The UF hostname.</td></tr>
                  <tr><td><code>Origin</code></td><td>The worker group the forwarder was last seen connecting to.</td></tr>
                  <tr><td><code>IP:Port</code></td><td>Source address of the S2S connection.</td></tr>
                  <tr><td><code>Last Seen</code></td><td>Timestamp of the most recent debug connection event.</td></tr>
                  <tr><td><code>OS</code> / <code>Arch</code></td><td>Operating system and CPU architecture reported by the UF.</td></tr>
                  <tr><td><code>S2S</code></td><td>Splunk-to-Splunk protocol version negotiated.</td></tr>
                  <tr><td><code>Version</code></td><td>The Splunk Universal Forwarder software version — the field this app exists to surface.</td></tr>
                  <tr><td><code>Total</code></td><td>Count of debug connection events seen for this forwarder over the window.</td></tr>
                </tbody>
              </table>
            </div>

            <Text as="h3" variant="heading-sm">FAQ</Text>
            <Collapse title="Is enabling DEBUG risky?">
              <Text variant="body-sm-normal" as="p">
                It&apos;s a short, targeted change to a single input channel that carries a TTL, so it
                reverts automatically after 15 minutes without any further action. When enabling, the app
                commits/deploys only the logger config file — it never touches other pending edits in the
                group. DEBUG on this channel is a supported, self-service operation.
              </Text>
            </Collapse>
            <Collapse title="Why don't I see any forwarders?">
              <Text variant="body-sm-normal" as="p">
                Forwarders only appear when they actually connect during the DEBUG window. If a UF is
                idle or reconnects infrequently, give it a few minutes, or run another window. Only
                events carrying a <code>version</code> field are counted, so pure stats traffic is
                ignored.
              </Text>
            </Collapse>
            <Collapse title="Where is the inventory stored?">
              <Text variant="body-sm-normal" as="p">
                In the app-scoped Cribl KV store, one record per forwarder under
                <code> {KV_FWD_PREFIX}&#123;id&#125;</code> (schema {CURRENT_SCHEMA_VERSION}). It is durable across
                reloads and shared globally across every worker group you monitor. Manage it on the
                <strong> Inventory</strong> tab — hide rows from the Monitor view and CSV export,
                or delete them entirely.
              </Text>
            </Collapse>
          </div>
        )}

        <Modal
          isOpen={showConfirm}
          title="Enable DEBUG logging?"
          confirmButtonText="Enable DEBUG"
          cancelButtonText="Cancel"
          onConfirm={() => {
            setShowConfirm(false);
            startDebugSession();
          }}
          onClose={() => setShowConfirm(false)}
        >
          <div className="modal-body">
            <Text as="p" variant="body-md-normal">
              This will set the log level of <code>{SPLUNK_LOGGER_ID}</code> to <strong>DEBUG</strong> on
              worker group <strong>{selectedGroup}</strong> for 15 minutes.
            </Text>
            <Text as="p" variant="body-md-normal">
              During that window the app will read the worker group logs to discover Universal
              Forwarders and reconcile their details against the stored state.
            </Text>
          </div>
        </Modal>

        <Modal
          isOpen={pendingDelete !== null}
          title="Delete saved forwarder?"
          confirmButtonText="Delete"
          cancelButtonText="Cancel"
          onConfirm={() => {
            if (pendingDelete) void deleteSaved(pendingDelete);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        >
          <div className="modal-body">
            <Text as="p" variant="body-md-normal">
              Remove <code>{pendingDelete}</code> from the saved forwarder inventory in the KV
              store? This cannot be undone.
            </Text>
          </div>
        </Modal>
      </div>
    </>
  );
}

export default App;
