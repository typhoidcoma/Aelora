// Aelora Dashboard — live features & interactivity

// --- State ---
let uptimeSeconds = 0;
let uptimeInterval = null;

// --- Toast system ---
function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- Collapsible sections ---
document.querySelectorAll(".section-header").forEach((header) => {
  header.addEventListener("click", (e) => {
    // Don't collapse when clicking buttons inside the header
    if (e.target.closest(".btn")) return;

    const section = header.dataset.section;
    const body = document.querySelector(`.section-body[data-section="${section}"]`);
    const isHidden = body.classList.toggle("hidden");
    header.classList.toggle("collapsed", isHidden);
  });
});

// --- Last updated ---
function updateTimestamp() {
  const el = document.getElementById("last-updated");
  el.textContent = "Updated " + new Date().toLocaleTimeString();
}

// --- Live uptime ticker ---
function startUptimeTicker(serverSeconds) {
  uptimeSeconds = Math.floor(serverSeconds || 0);
  document.getElementById("uptime").textContent = formatUptime(uptimeSeconds);

  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = setInterval(() => {
    uptimeSeconds++;
    document.getElementById("uptime").textContent = formatUptime(uptimeSeconds);
  }, 1000);
}

// --- Fetchers ---

async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    const badge = document.getElementById("status-badge");
    badge.innerHTML = `<span class="pulse-dot"></span> ${data.connected ? "Online" : "Offline"}`;
    badge.className = data.connected ? "badge online" : "badge offline";

    document.getElementById("conn-status").textContent =
      data.connected ? "Connected" : "Disconnected";
    document.getElementById("bot-username").textContent = data.username ?? "--";
    document.getElementById("guild-count").textContent = data.guildCount ?? "--";

    startUptimeTicker(data.uptime);
    updateTimestamp();
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

async function fetchSoul() {
  try {
    const res = await fetch("/api/soul");
    const data = await res.json();
    const statusEl = document.getElementById("soul-status");
    const tableEl = document.getElementById("soul-table");

    if (!data.enabled) {
      statusEl.textContent = "Soul system disabled (using fallback systemPrompt)";
      tableEl.style.display = "none";
      return;
    }

    const enabledCount = data.files.filter((f) => f.enabled).length;
    statusEl.innerHTML =
      `<div class="stat"><span class="label">Loaded:</span> ${new Date(data.loadedAt).toLocaleString()}</div>` +
      `<div class="stat"><span class="label">Prompt size:</span> ${data.promptLength.toLocaleString()} chars</div>` +
      `<div class="stat"><span class="label">Files:</span> ${data.files.length} total, ${enabledCount} enabled</div>`;

    tableEl.style.display = "";
    document.getElementById("soul-body").innerHTML = data.files
      .map(
        (f) => `
      <tr${f.enabled ? "" : ' style="opacity: 0.4"'}>
        <td><code>${esc(f.path)}</code></td>
        <td>${esc(f.section)}</td>
        <td>${esc(f.label)}</td>
        <td>${f.order}</td>
        <td>${f.enabled ? "Yes" : "No"}</td>
        <td>${f.contentLength.toLocaleString()} chars</td>
      </tr>`,
      )
      .join("");
  } catch {
    /* ignore */
  }
}

// --- Interactive actions ---

async function reloadSoul() {
  const btn = document.getElementById("soul-reload-btn");
  btn.disabled = true;
  btn.textContent = "Reloading...";

  try {
    const res = await fetch("/api/soul/reload", { method: "POST" });
    const data = await res.json();

    if (data.success) {
      showToast(`Soul reloaded: ${data.enabledCount}/${data.fileCount} files, ${data.promptLength.toLocaleString()} chars`);
      fetchSoul();
    } else {
      showToast(`Reload failed: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Reload error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Reload";
  }
}

async function testLLM() {
  const input = document.getElementById("llm-input");
  const btn = document.getElementById("llm-send-btn");
  const loading = document.getElementById("llm-loading");
  const responseDiv = document.getElementById("llm-response");
  const message = input.value.trim();

  if (!message) return;

  btn.disabled = true;
  loading.style.display = "";
  responseDiv.style.display = "none";

  try {
    const res = await fetch("/api/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();

    if (data.error) {
      showToast(`LLM error: ${data.error}`, "error");
    } else {
      responseDiv.style.display = "";
      responseDiv.querySelector("pre").textContent = data.reply;
    }
  } catch (err) {
    showToast(`Request failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    loading.style.display = "none";
  }
}

// Allow Ctrl+Enter to send
document.getElementById("llm-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    testLLM();
  }
});

// --- Utilities ---

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

// --- Init ---
fetchStatus();
fetchCron();
fetchConfig();
fetchSoul();
setInterval(fetchStatus, 5000);
setInterval(fetchCron, 10000);
