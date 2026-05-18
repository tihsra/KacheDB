import { useState, useEffect, useRef } from "react";

// ─── WebSocket Hook ───────────────────────────────────────────────────────────

function useStats(wsUrl) {
  const [stats, setStats]       = useState(null);
  const [connected, setConnected] = useState(false);
  const [history, setHistory]   = useState([]);
  const wsRef = useRef(null);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen  = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          setStats(data);
          setHistory(h => [...h.slice(-59), { t: Date.now(), ops: data.opsPerSec, keys: data.keyspace?.keyCount || 0 }]);
        } catch (_) {}
      };
    }
    connect();
    return () => wsRef.current?.close();
  }, [wsUrl]);

  return { stats, connected, history };
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ data, color = "#22c55e", height = 40 }) {
  if (!data || data.length < 2) return <svg width="100%" height={height} />;
  const max = Math.max(...data, 1);
  const w   = 200;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <polyline points={`0,${height} ${pts} ${w},${height}`}
        fill={color} fillOpacity="0.1" stroke="none" />
    </svg>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = "#22c55e", spark, sparkColor }) {
  return (
    <div style={{
      background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 12,
      padding: "16px 20px", display: "flex", flexDirection: "column", gap: 6,
      minWidth: 160,
    }}>
      <div style={{ color: "#888", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
      <div style={{ color, fontSize: 28, fontWeight: 700, fontFamily: "monospace", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: "#666", fontSize: 11 }}>{sub}</div>}
      {spark && spark.length > 1 && (
        <div style={{ marginTop: 4 }}>
          <Sparkline data={spark} color={sparkColor || color} height={36} />
        </div>
      )}
    </div>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({ title, dot }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, marginTop: 24 }}>
      {dot && <div style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />}
      <div style={{ color: "#aaa", fontSize: 12, textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 600 }}>
        {title}
      </div>
    </div>
  );
}

// ─── Replication Badge ────────────────────────────────────────────────────────

function ReplBadge({ role }) {
  const colors = { leader: "#f59e0b", follower: "#3b82f6", standalone: "#6b7280" };
  return (
    <span style={{
      background: colors[role] || "#6b7280", color: "#fff",
      borderRadius: 6, padding: "2px 10px", fontSize: 11, fontWeight: 700,
      textTransform: "uppercase", letterSpacing: 1,
    }}>{role}</span>
  );
}

// ─── Follower Row ─────────────────────────────────────────────────────────────

function FollowerRow({ f }) {
  const lagColor = f.lag === 0 ? "#22c55e" : f.lag < 10 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{
      display: "flex", gap: 16, padding: "8px 12px",
      background: "#0f0f1f", borderRadius: 8, fontSize: 12,
      alignItems: "center",
    }}>
      <span style={{ color: "#aaa" }}>Follower #{f.id}</span>
      <span style={{ color: f.ready ? "#22c55e" : "#f59e0b" }}>
        {f.ready ? "● ready" : "○ syncing"}
      </span>
      <span style={{ color: "#666" }}>offset {f.offset}</span>
      <span style={{ color: lagColor, marginLeft: "auto" }}>lag: {f.lag}</span>
    </div>
  );
}

// ─── Memory Bar ───────────────────────────────────────────────────────────────

function MemBar({ used, total }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const col = pct < 60 ? "#22c55e" : pct < 80 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#666", marginBottom: 4 }}>
        <span>{used} MB used</span>
        <span>{total} MB total</span>
      </div>
      <div style={{ background: "#111", borderRadius: 4, height: 6 }}>
        <div style={{ width: `${pct}%`, background: col, borderRadius: 4, height: "100%", transition: "width 0.5s" }} />
      </div>
    </div>
  );
}

// ─── Command Log ─────────────────────────────────────────────────────────────

function useCommandLog(stats) {
  const [log, setLog] = useState([]);
  const prev = useRef(0);

  useEffect(() => {
    if (!stats) return;
    const cur = stats.keyspace?.totalCmds || 0;
    if (cur > prev.current) {
      const delta = cur - prev.current;
      const entry = `+${delta} command${delta !== 1 ? "s" : ""} processed`;
      setLog(l => [{ ts: new Date().toLocaleTimeString(), msg: entry }, ...l.slice(0, 19)]);
      prev.current = cur;
    }
  }, [stats]);

  return log;
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const WS_PORT = 8379;
  const { stats, connected, history } = useStats(`ws://localhost:${WS_PORT}`);
  const cmdLog = useCommandLog(stats);

  const opsHistory  = history.map(h => h.ops);
  const keyHistory  = history.map(h => h.keys);

  if (!connected && !stats) {
    return (
      <div style={{
        minHeight: "100vh", background: "#0d0d1a", display: "flex",
        alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16,
      }}>
        <div style={{ fontSize: 48 }}>📡</div>
        <div style={{ color: "#fff", fontSize: 20, fontWeight: 700 }}>Connecting to mini-redis...</div>
        <div style={{ color: "#666", fontSize: 13, fontFamily: "monospace" }}>
          ws://localhost:{WS_PORT}
        </div>
        <div style={{ color: "#555", fontSize: 12, marginTop: 8 }}>
          Make sure the server is running: <span style={{ color: "#22c55e" }}>node src/server/Server.js</span>
        </div>
      </div>
    );
  }

  const ks   = stats?.keyspace   || {};
  const mem  = stats?.memory     || {};
  const repl = stats?.replication || {};
  const pers = stats?.persistence || {};
  const exp  = stats?.expiry      || {};

  const uptime = stats?.uptimeSeconds || 0;
  const uptimeStr = uptime < 60 ? `${uptime}s`
    : uptime < 3600 ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
    : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  return (
    <div style={{
      minHeight: "100vh", background: "#0d0d1a", color: "#e0e0e0",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "24px 32px",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8 }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: -1 }}>
          🗄 mini-redis
        </div>
        <ReplBadge role={repl.role || "standalone"} />
        <div style={{
          marginLeft: "auto", display: "flex", alignItems: "center", gap: 6,
          fontSize: 12, color: connected ? "#22c55e" : "#ef4444",
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: connected ? "#22c55e" : "#ef4444",
            boxShadow: connected ? "0 0 6px #22c55e" : "none",
          }} />
          {connected ? "Live" : "Disconnected"}
        </div>
      </div>
      <div style={{ color: "#555", fontSize: 12, marginBottom: 28 }}>
        uptime {uptimeStr} · pid {stats?.pid || "—"} · port {stats?.port || 6379}
      </div>

      {/* Top stats */}
      <SectionHeader title="Performance" dot="#22c55e" />
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <StatCard
          label="Ops / sec"
          value={stats?.opsPerSec?.toLocaleString() || "0"}
          sub="commands per second"
          color="#22c55e"
          spark={opsHistory}
          sparkColor="#22c55e"
        />
        <StatCard
          label="Total Keys"
          value={ks.keyCount?.toLocaleString() || "0"}
          sub="in keyspace"
          color="#3b82f6"
          spark={keyHistory}
          sparkColor="#3b82f6"
        />
        <StatCard
          label="Hit Rate"
          value={`${ks.hitRate || "0.0"}%`}
          sub={`${ks.hits || 0} hits · ${ks.misses || 0} misses`}
          color={parseFloat(ks.hitRate) > 80 ? "#22c55e" : "#f59e0b"}
        />
        <StatCard
          label="Clients"
          value={stats?.connectedClients || "0"}
          sub="connected"
          color="#a78bfa"
        />
        <StatCard
          label="Total Commands"
          value={ks.totalCmds?.toLocaleString() || "0"}
          sub="since startup"
          color="#f59e0b"
        />
      </div>

      {/* Memory */}
      <SectionHeader title="Memory" dot="#a78bfa" />
      <div style={{
        background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 12,
        padding: "16px 20px", maxWidth: 500,
      }}>
        <div style={{ display: "flex", gap: 32, marginBottom: 8 }}>
          <div>
            <div style={{ color: "#888", fontSize: 11 }}>Heap Used</div>
            <div style={{ color: "#a78bfa", fontSize: 22, fontWeight: 700, fontFamily: "monospace" }}>
              {mem.heapUsedMB || "0"} MB
            </div>
          </div>
          <div>
            <div style={{ color: "#888", fontSize: 11 }}>RSS</div>
            <div style={{ color: "#6b7280", fontSize: 22, fontWeight: 700, fontFamily: "monospace" }}>
              {mem.rssMB || "0"} MB
            </div>
          </div>
        </div>
        <MemBar used={parseFloat(mem.heapUsedMB) || 0} total={parseFloat(mem.heapTotalMB) || 1} />
      </div>

      {/* Persistence + Expiry */}
      <SectionHeader title="Persistence & Expiry" dot="#f59e0b" />
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={{
          background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 12,
          padding: "16px 20px", minWidth: 220,
        }}>
          <div style={{ color: "#888", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            WAL
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Row label="Entries" value={pers.walEntries || 0} />
            <Row label="Size" value={formatBytes(pers.walSizeBytes || 0)} />
          </div>
        </div>
        <div style={{
          background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 12,
          padding: "16px 20px", minWidth: 220,
        }}>
          <div style={{ color: "#888", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            Expiry Sweeper
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Row label="Total swept" value={exp.totalSwept || 0} />
            <Row label="Sweeps run"  value={exp.sweepCount || 0} />
          </div>
        </div>
      </div>

      {/* Replication */}
      {(repl.role === "leader" || repl.role === "follower") && (
        <>
          <SectionHeader title="Replication" dot={repl.role === "leader" ? "#f59e0b" : "#3b82f6"} />
          {repl.role === "leader" && repl.leader && (
            <div style={{
              background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 12,
              padding: "16px 20px", maxWidth: 560,
            }}>
              <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
                <StatMini label="Followers"    value={repl.leader.followerCount || 0} />
                <StatMini label="Repl Offset"  value={repl.leader.offset || 0} />
                <StatMini label="Repl Port"    value={repl.leader.replicationPort || "—"} />
              </div>
              {(repl.leader.followers || []).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {repl.leader.followers.map(f => <FollowerRow key={f.id} f={f} />)}
                </div>
              )}
              {(repl.leader.followers || []).length === 0 && (
                <div style={{ color: "#555", fontSize: 12 }}>No followers connected</div>
              )}
            </div>
          )}
          {repl.role === "follower" && repl.follower && (
            <div style={{
              background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 12,
              padding: "16px 20px", maxWidth: 400,
            }}>
              <div style={{ display: "flex", gap: 24 }}>
                <StatMini label="Leader"       value={`${repl.follower.leaderHost}:${repl.follower.leaderReplPort}`} />
                <StatMini label="Sync Offset"  value={repl.follower.offset || 0} />
                <StatMini label="Status"       value={repl.follower.connected ? "connected" : "reconnecting"} color={repl.follower.connected ? "#22c55e" : "#ef4444"} />
              </div>
            </div>
          )}
        </>
      )}

      {/* Activity Log */}
      <SectionHeader title="Activity" dot="#666" />
      <div style={{
        background: "#0f0f1f", border: "1px solid #1e1e3a", borderRadius: 12,
        padding: "12px 16px", maxWidth: 560, maxHeight: 200, overflowY: "auto",
        fontFamily: "monospace", fontSize: 12,
      }}>
        {cmdLog.length === 0
          ? <div style={{ color: "#444" }}>Waiting for activity...</div>
          : cmdLog.map((entry, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "3px 0", borderBottom: "1px solid #1a1a2a" }}>
              <span style={{ color: "#444", minWidth: 75 }}>{entry.ts}</span>
              <span style={{ color: "#888" }}>{entry.msg}</span>
            </div>
          ))
        }
      </div>

      {/* Footer */}
      <div style={{ color: "#333", fontSize: 11, marginTop: 32, textAlign: "center" }}>
        mini-redis dashboard · refreshes every 1s · ws://localhost:{WS_PORT}
      </div>
    </div>
  );
}

// ─── Small Helpers ────────────────────────────────────────────────────────────

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
      <span style={{ color: "#666" }}>{label}</span>
      <span style={{ color: "#e0e0e0", fontFamily: "monospace" }}>{value}</span>
    </div>
  );
}

function StatMini({ label, value, color = "#e0e0e0" }) {
  return (
    <div>
      <div style={{ color: "#666", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
      <div style={{ color, fontSize: 16, fontWeight: 700, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
