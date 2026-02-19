// Aelora Dashboard — polls API endpoints and updates the DOM

async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    const badge = document.getElementById("status-badge");
    badge.textContent = data.connected ? "Online" : "Offline";
    badge.className = data.connected ? "badge online" : "badge offline";

    document.getElementById("conn-status").textContent =
      data.connected ? "Connected" : "Disconnected";
    document.getElementById("bot-username").textContent = data.username ?? "--";
    document.getElementById("guild-count").textContent = data.guildCount ?? "--";
    document.getElementById("uptime").textContent = formatUptime(data.uptime);
  } catch {
    /* ignore fetch errors */
  }
}

async function fetchCron() {
  try {
    const res = await fetch("/api/cron");
    const jobs = await res.json();
    const tbody = document.getElementById("cron-body");

    if (jobs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">No cron jobs configured</td></tr>';
      return;
    }

    tbody.innerHTML = jobs
      .map(
        (j) => `
      <tr>
        <td>${esc(j.name)}</td>
        <td><code>${esc(j.schedule)}</code></td>
        <td>${esc(j.type)}</td>
        <td>${j.enabled ? "Yes" : "No"}</td>
        <td>${j.lastRun ? new Date(j.lastRun).toLocaleString() : "--"}</td>
        <td>${j.nextRun ? new Date(j.nextRun).toLocaleString() : "--"}</td>
        <td>${j.lastError ? '<span class="error">Error</span>' : '<span class="ok">OK</span>'}</td>
      </tr>`,
      )
      .join("");
  } catch {
    /* ignore */
  }
}

async function fetchConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    document.getElementById("config-display").textContent = JSON.stringify(cfg, null, 2);
  } catch {
    /* ignore */
  }
}

function formatUptime(seconds) {
  if (!seconds) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function esc(str) {
  const el = document.createElement("span");
  el.textContent = str ?? "";
  return el.innerHTML;
}

// Initial load + polling
fetchStatus();
fetchCron();
fetchConfig();
setInterval(fetchStatus, 5000);
setInterval(fetchCron, 10000);
