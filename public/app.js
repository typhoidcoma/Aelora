// Aelora Dashboard

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
    if (e.target.closest(".btn, select, input")) return;
    const section = header.dataset.section;
    const body = document.querySelector(`.section-body[data-section="${section}"]`);
    const isHidden = body.classList.toggle("hidden");
    header.classList.toggle("collapsed", isHidden);
  });
});

// --- Last updated ---
function updateTimestamp() {
  const el = document.getElementById("last-updated");
  el.textContent = "Updated " + formatTime(new Date());
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

// --- Auth ---

function getApiKey() {
  return localStorage.getItem("aelora-api-key") || "";
}

function setApiKey(key) {
  localStorage.setItem("aelora-api-key", key);
}

function clearApiKey() {
  localStorage.removeItem("aelora-api-key");
  location.reload();
}

async function apiFetch(url, options = {}) {
  const key = getApiKey();
  if (key) {
    options.headers = { ...options.headers, Authorization: `Bearer ${key}` };
  }
  const res = await window.fetch(url, options);
  if (res.status === 401) {
    promptForApiKey();
    throw new Error("Unauthorized");
  }
  return res;
}

function apiEventSource(url) {
  const key = getApiKey();
  const separator = url.includes("?") ? "&" : "?";
  const finalUrl = key ? `${url}${separator}token=${encodeURIComponent(key)}` : url;
  return new EventSource(finalUrl);
}

async function checkAuth() {
  try {
    const res = await window.fetch("/api/status");
    const data = await res.json();
    if (data.authRequired) {
      if (!getApiKey()) {
        promptForApiKey();
      } else {
        const btn = document.getElementById("logout-btn");
        if (btn) btn.style.display = "";
      }
    }
  } catch {
    /* ignore */
  }
}

function promptForApiKey() {
  const key = prompt("This dashboard requires an API key.\nEnter your API key:");
  if (key) {
    setApiKey(key.trim());
    location.reload();
  }
}

// --- Fetchers ---

async function fetchStatus() {
  try {
    const res = await apiFetch("/api/status");
    const data = await res.json();

    const badge = document.getElementById("status-badge");
    badge.innerHTML = `<span class="pulse-dot"></span> ${data.connected ? "Online" : "Offline"}`;
    badge.className = data.connected ? "badge online" : "badge offline";

    document.getElementById("guild-count").textContent = data.guildCount ?? "--";
    startUptimeTicker(data.uptime);
    updateTimestamp();
  } catch {
    /* ignore */
  }
}

async function fetchConfig() {
  try {
    const res = await apiFetch("/api/config");
    const cfg = await res.json();
    document.getElementById("model-name").textContent = cfg.llm?.model ?? "--";
  } catch {
    /* ignore */
  }
}

async function fetchHeartbeat() {
  try {
    const res = await apiFetch("/api/heartbeat");
    const data = await res.json();
    const el = document.getElementById("heartbeat-status-badge");

    if (data.running) {
      el.innerHTML = `<span class="ok">${data.tickCount} ticks</span>`;
    } else {
      el.innerHTML = '<span class="error">stopped</span>';
    }
  } catch {
    /* ignore */
  }
}

// --- Sessions ---

async function fetchSessions() {
  try {
    const res = await apiFetch("/api/sessions");
    const sessions = await res.json();
    const container = document.getElementById("sessions-content");

    if (sessions.length === 0) {
      container.innerHTML = '<span class="muted">No sessions yet</span>';
      return;
    }

    // Sort by most recent activity
    sessions.sort((a, b) => new Date(b.lastMessage) - new Date(a.lastMessage));

    container.innerHTML = sessions
      .map((s) => {
        const users = Object.values(s.users);
        const userList = users
          .sort((a, b) => b.messageCount - a.messageCount)
          .map((u) => `<span class="session-user">${esc(u.username)} <span class="muted">(${u.messageCount})</span></span>`)
          .join(", ");

        const ago = timeAgo(s.lastMessage);

        return `
          <div class="session-row" onclick="showSessionDetail('${esc(s.channelId)}')" style="cursor:pointer">
            <div class="session-channel">
              <code>#${esc(s.channelName || s.channelId)}</code>
              <span class="session-count">${s.messageCount} messages</span>
            </div>
            <div class="session-users">${userList}</div>
            <div class="session-time">Last active ${ago}</div>
            <button class="btn btn-danger btn-xs" onclick="event.stopPropagation(); deleteSession('${esc(s.channelId)}')">&times;</button>
          </div>`;
      })
      .join("");
  } catch {
    /* ignore */
  }
}

async function deleteSession(channelId) {
  try {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(channelId)}`, { method: "DELETE" });
    const data = await res.json();

    if (data.success) {
      showToast("Session deleted");
      fetchSessions();
    } else {
      showToast(`Delete failed: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Delete error: ${err.message}`, "error");
  }
}

async function clearAllSessions() {
  if (!confirm("Clear all sessions?")) return;

  try {
    const res = await apiFetch("/api/sessions", { method: "DELETE" });
    const data = await res.json();

    if (data.success) {
      showToast(`Cleared ${data.deleted} session(s)`);
      fetchSessions();
    } else {
      showToast("Clear failed", "error");
    }
  } catch (err) {
    showToast(`Clear error: ${err.message}`, "error");
  }
}

// --- Session Detail (popout) ---

async function showSessionDetail(channelId) {
  try {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(channelId)}`);
    if (!res.ok) {
      showToast("Session no longer exists", "error");
      fetchSessions();
      return;
    }
    const s = await res.json();

    // Users table
    const users = Object.entries(s.users)
      .map(([id, u]) => ({ id, ...u }))
      .sort((a, b) => b.messageCount - a.messageCount);

    const userRows = users
      .map(
        (u) => `
        <tr>
          <td>${esc(u.username)}</td>
          <td><code>${esc(u.id)}</code></td>
          <td>${u.messageCount}</td>
          <td>${timeAgo(u.lastMessage)}</td>
        </tr>`,
      )
      .join("");

    // Memories section
    let memoriesHtml = "";
    if (s.memories && Object.keys(s.memories).length > 0) {
      const scopes = Object.entries(s.memories).map(([scope, facts]) => {
        const userId = scope.startsWith("user:") ? scope.slice(5) : null;
        const user = userId ? s.users[userId] : null;
        const label = user ? `${esc(user.username)} (${esc(scope)})` : esc(scope);

        const factList = facts
          .map((f) => `<div class="memory-fact">${esc(f.fact)} <span class="muted">${timeAgo(f.savedAt)}</span></div>`)
          .join("");

        return `<div class="memory-scope"><div class="memory-scope-header">${label} <span class="muted">(${facts.length})</span></div>${factList}</div>`;
      });
      memoriesHtml = scopes.join("");
    } else {
      memoriesHtml = '<span class="muted">No memories for this session</span>';
    }

    const overlay = document.getElementById("session-overlay");
    document.getElementById("session-overlay-body").innerHTML = `
      <div class="session-detail-header">
        <h3>#${esc(s.channelName || s.channelId)}</h3>
        <button class="btn btn-xs" onclick="hideSessionDetail()">&times;</button>
      </div>

      <div class="session-detail-stats">
        <div><span class="muted">Channel ID</span> <code>${esc(s.channelId)}</code></div>
        <div><span class="muted">Guild ID</span> <code>${esc(s.guildId || "DM")}</code></div>
        <div><span class="muted">First message</span> ${formatDateTime(s.firstMessage)}</div>
        <div><span class="muted">Last message</span> ${formatDateTime(s.lastMessage)}</div>
        <div><span class="muted">Total messages</span> ${s.messageCount}</div>
        <div><span class="muted">Users</span> ${users.length}</div>
      </div>

      <h3>Users</h3>
      <table>
        <thead>
          <tr><th>User</th><th>ID</th><th>Messages</th><th>Last Active</th></tr>
        </thead>
        <tbody>${userRows}</tbody>
      </table>

      <h3>Memories</h3>
      ${memoriesHtml}
    `;

    overlay.style.display = "";
  } catch (err) {
    showToast(`Error loading session: ${err.message}`, "error");
  }
}

function hideSessionDetail() {
  document.getElementById("session-overlay").style.display = "none";
}

// --- Memory ---

async function fetchMemory() {
  try {
    const res = await apiFetch("/api/memory");
    const data = await res.json();
    const container = document.getElementById("memory-content");
    const scopes = Object.keys(data);

    if (scopes.length === 0) {
      container.innerHTML = '<span class="muted">No memories stored yet</span>';
      return;
    }

    container.innerHTML = scopes
      .map((scope) => {
        const facts = data[scope];
        const label = scope.startsWith("user:") ? `User ${scope.slice(5)}` : scope.startsWith("channel:") ? `Channel ${scope.slice(8)}` : scope;
        const factRows = facts
          .map(
            (f, i) =>
              `<div class="memory-fact">
                <span class="memory-fact-text">${esc(f.fact)}</span>
                <span class="memory-fact-time muted">${timeAgo(f.savedAt)}</span>
                <button class="btn btn-danger btn-xs" onclick="deleteMemoryFact('${esc(scope)}', ${i})">&times;</button>
              </div>`,
          )
          .join("");

        return `
          <div class="memory-scope">
            <div class="memory-scope-header">
              <code>${esc(label)}</code>
              <span class="muted">${facts.length} fact(s)</span>
              <button class="btn btn-danger btn-xs" onclick="clearMemoryScope('${esc(scope)}')">Clear</button>
            </div>
            ${factRows}
          </div>`;
      })
      .join("");
  } catch {
    /* ignore */
  }
}

async function deleteMemoryFact(scope, index) {
  try {
    const res = await apiFetch(`/api/memory/${encodeURIComponent(scope)}/${index}`, { method: "DELETE" });
    const data = await res.json();

    if (data.success) {
      showToast("Fact deleted");
      fetchMemory();
    } else {
      showToast(`Delete failed: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Delete error: ${err.message}`, "error");
  }
}

async function clearMemoryScope(scope) {
  if (!confirm(`Clear all facts for "${scope}"?`)) return;

  try {
    const res = await apiFetch(`/api/memory/${encodeURIComponent(scope)}`, { method: "DELETE" });
    const data = await res.json();

    if (data.success) {
      showToast(`Cleared ${data.deleted} fact(s)`);
      fetchMemory();
    } else {
      showToast("Clear failed", "error");
    }
  } catch (err) {
    showToast(`Clear error: ${err.message}`, "error");
  }
}

// --- Persona ---

// --- Persona Card Grid ---

let currentActivePersona = null;

const MOOD_COLORS = {
  joy: "#f2c572", trust: "#8bc58b", fear: "#9b7fbf", surprise: "#5fbfbf",
  sadness: "#6a8cb7", disgust: "#8b8b6a", anger: "#c56a6a", anticipation: "#d4a056",
};

async function fetchPersonas() {
  try {
    const [personaRes, moodRes] = await Promise.all([
      apiFetch("/api/personas"),
      apiFetch("/api/mood"),
    ]);
    const data = await personaRes.json();
    const mood = await moodRes.json();
    const grid = document.getElementById("persona-cards");
    currentActivePersona = data.activePersona || null;

    let html = "";
    for (const p of data.personas) {
      const isActive = p.name === data.activePersona;
      const displayName = p.botName || p.name;
      const showSlug = p.botName && p.botName.toLowerCase() !== p.name;
      const emojis = ["🦋","🔮","🌙","✨","🎭","🌿","🐉","🦊","🎪","🌸","🦉","🎯","🧭","🪐","🌊","🍄","🦚","🔥","🧩","🎸","🐺","🌻","💎","🦅","🏔️","🫧","🪶","🐝","🎨","⚡"];
      const hash = [...p.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
      const emoji = emojis[Math.abs(hash) % emojis.length];

      let moodHtml = "";
      if (isActive && mood.active) {
        const color = MOOD_COLORS[mood.emotion] || "var(--text-muted)";
        const label = mood.label.charAt(0).toUpperCase() + mood.label.slice(1);
        const secondary = mood.secondary ? ` + ${mood.secondary}` : "";
        moodHtml = `<div class="persona-card-mood" style="--mood-color: ${color}"><span class="mood-dot"></span>${esc(label)}${esc(secondary)}</div>`;
      }

      html += `
        <div class="persona-card${isActive ? " active" : ""}" onclick="switchPersona('${esc(p.name)}')">
          ${isActive ? '<div class="persona-card-badge">Active</div>' : ""}
          <div class="persona-card-icon">${emoji}</div>
          <div class="persona-card-name">${esc(displayName)}</div>
          ${showSlug ? `<div class="persona-card-id muted">${esc(p.name)}</div>` : ""}
          <div class="persona-card-desc">${esc(p.description) || '<span class="muted">No description</span>'}</div>
          ${moodHtml}
          <div class="persona-card-meta">${p.fileCount} file(s)</div>
          <div class="persona-card-actions">
            <button class="btn btn-xs" onclick="event.stopPropagation(); editPersona('${esc(p.name)}')">Edit</button>
          </div>
        </div>`;
    }

    // "+ New Persona" card
    html += `
      <div class="persona-card persona-card-new" onclick="showCreatePersonaForm()">
        <div class="persona-card-plus">+</div>
        <div class="persona-card-desc">New Persona</div>
      </div>`;

    grid.innerHTML = html;
  } catch {
    const grid = document.getElementById("persona-cards");
    if (grid) grid.innerHTML = '<div class="card"><span class="muted">Failed to load personas</span></div>';
  }
}

function updateMoodOnCard(mood) {
  const activeCard = document.querySelector(".persona-card.active");
  if (!activeCard) return;

  // Remove existing mood element if present
  const existing = activeCard.querySelector(".persona-card-mood");
  if (existing) existing.remove();

  if (!mood.active) return;

  const color = MOOD_COLORS[mood.emotion] || "var(--text-muted)";
  const label = mood.label.charAt(0).toUpperCase() + mood.label.slice(1);
  const secondary = mood.secondary ? ` + ${mood.secondary}` : "";

  const el = document.createElement("div");
  el.className = "persona-card-mood";
  el.style.setProperty("--mood-color", color);
  el.innerHTML = `<span class="mood-dot"></span>${esc(label)}${esc(secondary)}`;

  // Insert before .persona-card-meta
  const meta = activeCard.querySelector(".persona-card-meta");
  if (meta) {
    meta.parentNode.insertBefore(el, meta);
  } else {
    activeCard.appendChild(el);
  }
}

async function switchPersona(name) {
  try {
    const res = await apiFetch("/api/persona/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: name }),
    });
    const data = await res.json();

    if (data.success) {
      showToast(`Switched to "${data.botName || name}"`);
      hidePersonaEditor();
      hideCreatePersonaForm();
      fetchPersonas();
      fetchPersona();
    } else {
      showToast(`Switch failed: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Switch error: ${err.message}`, "error");
  }
}

// --- Create Persona ---

function showCreatePersonaForm() {
  document.getElementById("persona-create-form").style.display = "";
  document.getElementById("persona-create-botname").value = "";
  document.getElementById("persona-create-name").value = "";
  document.getElementById("persona-create-desc").value = "";
  document.getElementById("persona-create-botname").focus();
}

function hideCreatePersonaForm() {
  document.getElementById("persona-create-form").style.display = "none";
}

async function submitCreatePersona() {
  const botName = document.getElementById("persona-create-botname").value.trim();
  const name = document.getElementById("persona-create-name").value.trim();
  const description = document.getElementById("persona-create-desc").value.trim();

  if (!name) {
    showToast("Folder name is required", "error");
    return;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    showToast("Folder name must be lowercase letters, numbers, and hyphens (e.g. 'my-persona')", "error");
    return;
  }

  const createBtn = document.querySelector("#persona-create-form .btn-primary");
  if (createBtn) { createBtn.disabled = true; createBtn.textContent = "Creating..."; }

  try {
    const res = await apiFetch("/api/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, botName }),
    });
    const data = await res.json();

    if (data.success) {
      showToast(`Created persona "${botName || name}"`);
      hideCreatePersonaForm();
      fetchPersonas();
    } else {
      showToast(data.error || "Create failed", "error");
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
  } finally {
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = "Create"; }
  }
}


// --- Persona File Editor ---

let editorCurrentPath = null;

async function editPersona(name) {
  // Open the editor for soul.md (fallback to legacy persona.md)
  try {
    const soulPath = `${name}/soul.md`;
    const res = await apiFetch(`/api/persona/file?path=${encodeURIComponent(soulPath)}`);
    if (res.ok) {
      openPersonaEditor(soulPath);
    } else {
      openPersonaEditor(`${name}/persona.md`);
    }
  } catch (err) {
    showToast(`Error opening editor: ${err.message}`, "error");
  }
}

async function openPersonaEditor(relPath) {
  try {
    const res = await apiFetch(`/api/persona/file?path=${encodeURIComponent(relPath)}`);
    if (!res.ok) {
      showToast("File not found", "error");
      return;
    }
    const file = await res.json();
    if (!file || !file.meta) {
      showToast("Invalid file data", "error");
      return;
    }

    editorCurrentPath = relPath;
    document.getElementById("editor-file-path").textContent = relPath;
    document.getElementById("editor-label").value = file.meta.label || "";
    document.getElementById("editor-section").value = file.meta.section || "";
    document.getElementById("editor-order").value = file.meta.order;
    document.getElementById("editor-enabled").value = file.meta.enabled ? "true" : "false";
    document.getElementById("editor-content").value = file.content;

    // Show description and botName fields for soul.md (or legacy persona.md)
    const isSoulOrPersonaMd = relPath.endsWith("/soul.md") || relPath.endsWith("/persona.md");
    document.getElementById("editor-desc-row").style.display = isSoulOrPersonaMd ? "" : "none";
    document.getElementById("editor-description").value = file.meta.description || "";
    document.getElementById("editor-botname-row").style.display = isSoulOrPersonaMd ? "" : "none";
    document.getElementById("editor-botname").value = file.meta.botName || "";

    document.getElementById("persona-editor").style.display = "";
    document.getElementById("persona-editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
  }
}

function hidePersonaEditor() {
  document.getElementById("persona-editor").style.display = "none";
  editorCurrentPath = null;
}

async function savePersonaFile() {
  if (!editorCurrentPath) return;
  const saveBtn = document.getElementById("editor-save-btn");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }

  const body = {
    path: editorCurrentPath,
    content: document.getElementById("editor-content").value,
    meta: {
      label: document.getElementById("editor-label").value,
      section: document.getElementById("editor-section").value,
      order: parseInt(document.getElementById("editor-order").value) || 100,
      enabled: document.getElementById("editor-enabled").value === "true",
      description: document.getElementById("editor-description").value,
      botName: document.getElementById("editor-botname").value,
    },
  };

  try {
    const res = await apiFetch("/api/persona/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.success) {
      showToast("File saved");
      fetchPersona();
      fetchPersonas();
    } else {
      showToast(data.error || "Save failed", "error");
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
  }
}

async function deletePersonaFile() {
  if (!editorCurrentPath) return;
  if (!confirm(`Delete "${editorCurrentPath}"?`)) return;

  try {
    const res = await apiFetch("/api/persona/file", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: editorCurrentPath }),
    });
    const data = await res.json();

    if (data.success) {
      showToast("File deleted");
      hidePersonaEditor();
      fetchPersona();
      fetchPersonas();
    } else {
      showToast(data.error || "Delete failed", "error");
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
  }
}

async function showNewFileForm() {
  if (!currentActivePersona) {
    showToast("No active persona loaded", "error");
    return;
  }

  const filename = prompt(`New file name (e.g. 'lore.md' or 'skills/combat.md'):\n\nWill be created in: ${currentActivePersona}/`);
  if (!filename) return;

  const path = `${currentActivePersona}/${filename.replace(/^\/+/, "")}`;
  if (!path.endsWith(".md")) {
    showToast("File must end in .md", "error");
    return;
  }

  const label = filename.replace(/\.md$/, "").split("/").pop();

  try {
    const res = await apiFetch("/api/persona/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        content: "# " + label + "\n\nContent here.\n",
        meta: { order: 100, enabled: true, label, section: "custom" },
      }),
    });
    const data = await res.json();

    if (data.success) {
      showToast("File created");
      fetchPersona();
      openPersonaEditor(path);
    } else {
      showToast(data.error || "Create failed", "error");
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
  }
}

// --- Persona Status & File Table ---

async function fetchPersona() {
  try {
    const res = await apiFetch("/api/persona");
    const data = await res.json();
    const statusEl = document.getElementById("persona-status");
    const tableEl = document.getElementById("persona-table");

    if (!data.enabled) {
      statusEl.textContent = "Persona system disabled";
      tableEl.style.display = "none";
      return;
    }

    const enabledCount = data.files.filter((f) => f.enabled).length;
    statusEl.innerHTML =
      `<span class="stat"><span class="label">Character:</span> ${esc(data.botName || data.activePersona)}</span>` +
      `<span class="stat-sep">|</span>` +
      `<span class="stat"><span class="label">Persona:</span> ${esc(data.activePersona)}</span>` +
      `<span class="stat-sep">|</span>` +
      `<span class="stat"><span class="label">Prompt:</span> ${data.promptLength.toLocaleString()} chars</span>` +
      `<span class="stat-sep">|</span>` +
      `<span class="stat"><span class="label">Files:</span> ${enabledCount}/${data.files.length}</span>`;

    tableEl.style.display = "";
    document.getElementById("persona-body").innerHTML = data.files
      .map(
        (f) => `
      <tr${f.enabled ? "" : ' class="disabled-row"'}>
        <td><code>${esc(f.path)}</code></td>
        <td>${esc(f.section)}</td>
        <td>${f.order}</td>
        <td>${f.enabled ? '<span class="ok">Yes</span>' : '<span class="muted">No</span>'}</td>
        <td>${f.contentLength.toLocaleString()}</td>
        <td><button class="btn btn-xs" onclick="openPersonaEditor('${esc(f.path)}')">Edit</button></td>
      </tr>`,
      )
      .join("");
  } catch {
    const statusEl = document.getElementById("persona-status");
    if (statusEl) statusEl.textContent = "Failed to load persona status";
  }
}

async function reloadPersona() {
  const btn = document.getElementById("persona-reload-btn");
  btn.disabled = true;
  btn.textContent = "Reloading...";

  try {
    const res = await apiFetch("/api/persona/reload", { method: "POST" });
    const data = await res.json();

    if (data.success) {
      showToast(`Persona reloaded: ${data.enabledCount}/${data.fileCount} files, ${data.promptLength.toLocaleString()} chars`);
      fetchPersona();
      fetchPersonas();
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

// --- LLM Test ---

async function testLLM() {
  const input = document.getElementById("llm-input");
  const btn = document.getElementById("llm-send-btn");
  const loading = document.getElementById("llm-loading");
  const responseDiv = document.getElementById("llm-response");
  const pre = responseDiv.querySelector("pre");
  const message = input.value.trim();

  if (!message) return;

  btn.disabled = true;
  loading.style.display = "";
  loading.textContent = "Thinking...";
  responseDiv.style.display = "";
  pre.textContent = "";

  try {
    const res = await apiFetch("/api/llm/test/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      const data = await res.json();
      showToast(`LLM error: ${data.error}`, "error");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6));

          if (payload.token) {
            pre.textContent += payload.token;
            pre.scrollTop = pre.scrollHeight;
            if (loading.textContent !== "Streaming...") {
              loading.textContent = "Streaming...";
            }
          }

          if (payload.error) {
            showToast(`LLM error: ${payload.error}`, "error");
          }
        } catch {
          // malformed JSON line
        }
      }
    }
  } catch (err) {
    showToast(`Request failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    loading.style.display = "none";
    loading.textContent = "Thinking...";
  }
}

document.getElementById("llm-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    testLLM();
  }
});

// --- Tools ---

async function fetchTools() {
  try {
    const res = await apiFetch("/api/tools");
    const tools = await res.json();
    const tbody = document.getElementById("tools-body");

    if (tools.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">No tools loaded</td></tr>';
      return;
    }

    tbody.innerHTML = tools
      .map(
        (t) => `
      <tr>
        <td><code>${esc(t.name)}</code></td>
        <td>${esc(t.description)}</td>
        <td>${t.enabled ? '<span class="ok">Yes</span>' : '<span class="error">No</span>'}</td>
        <td><button class="btn" onclick="toggleTool('${esc(t.name)}')">${t.enabled ? "Disable" : "Enable"}</button></td>
      </tr>`,
      )
      .join("");
  } catch {
    /* ignore */
  }
}

async function toggleTool(name) {
  try {
    const res = await apiFetch(`/api/tools/${encodeURIComponent(name)}/toggle`, { method: "POST" });
    const data = await res.json();

    if (data.error) {
      showToast(`Toggle failed: ${data.error}`, "error");
    } else {
      showToast(`Tool "${name}" is now ${data.enabled ? "enabled" : "disabled"}`);
      fetchTools();
    }
  } catch (err) {
    showToast(`Toggle error: ${err.message}`, "error");
  }
}

// --- Console / Log stream ---

const MAX_CONSOLE_LINES = 200;
const seenEntries = new Set();

function entryKey(entry) {
  return `${entry.ts}|${entry.level}|${entry.message}`;
}

function appendLogLine(entry) {
  const key = entryKey(entry);
  if (seenEntries.has(key)) return;
  seenEntries.add(key);

  const output = document.getElementById("console-output");
  const line = document.createElement("div");
  line.className = "log-line";

  const time = entry.ts ? formatTime(entry.ts) : "";
  const levelClass = entry.level === "error" ? "log-error" : entry.level === "warn" ? "log-warn" : "";

  line.innerHTML =
    `<span class="log-time">${esc(time)}</span>` +
    `<span class="${levelClass}">${esc(entry.message)}</span>`;

  output.appendChild(line);

  while (output.children.length > MAX_CONSOLE_LINES) {
    output.removeChild(output.firstChild);
  }

  output.scrollTop = output.scrollHeight;
}

function clearConsole() {
  document.getElementById("console-output").innerHTML = "";
  seenEntries.clear();
}

async function initConsole() {
  try {
    const res = await apiFetch("/api/logs");
    const logs = await res.json();
    for (const entry of logs) {
      appendLogLine(entry);
    }
  } catch {
    /* ignore */
  }

  const evtSource = apiEventSource("/api/logs/stream");
  evtSource.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data);
      appendLogLine(entry);
    } catch {
      /* ignore */
    }
  };

  // Live mood updates on persona cards
  evtSource.addEventListener("mood", (event) => {
    try {
      const mood = JSON.parse(event.data);
      updateMoodOnCard(mood);
    } catch {
      /* ignore */
    }
  });
}

// --- Resizable sidebar ---

(function initResize() {
  const handle = document.getElementById("resize-handle");
  const aside = document.querySelector("aside");
  if (!handle || !aside) return;

  const saved = localStorage.getItem("sidebar-width");
  if (saved) aside.style.width = saved + "px";

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("active");
    document.body.classList.add("resizing");
  });

  handle.addEventListener("pointermove", (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const newWidth = window.innerWidth - e.clientX - 2;
    const clamped = Math.max(180, Math.min(newWidth, 600));
    aside.style.width = clamped + "px";
  });

  handle.addEventListener("pointerup", (e) => {
    if (handle.hasPointerCapture(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    handle.classList.remove("active");
    document.body.classList.remove("resizing");
    localStorage.setItem("sidebar-width", parseInt(aside.style.width));
  });
})();

// --- Utilities ---

function formatUptime(seconds) {
  if (!seconds) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeUntil(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

function formatTime(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTime(d);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

function esc(str) {
  const el = document.createElement("span");
  el.textContent = str ?? "";
  return el.innerHTML;
}

function cronToHuman(expr) {
  if (!expr) return "";
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  const days = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun" };
  const months = { 1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr", 5: "May", 6: "Jun", 7: "Jul", 8: "Aug", 9: "Sep", 10: "Oct", 11: "Nov", 12: "Dec" };

  function fmtTime(h, m) {
    const hr = parseInt(h);
    const mn = parseInt(m);
    const ampm = hr >= 12 ? "PM" : "AM";
    const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
    return `${h12}:${String(mn).padStart(2, "0")} ${ampm}`;
  }

  // Every N minutes: */N * * * *
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${min.slice(2)} min`;
  }

  // Every N hours: 0 */N * * *
  if (min === "0" && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    const n = hour.slice(2);
    return `Every ${n} hr${n === "1" ? "" : "s"}`;
  }

  // Every hour at :MM
  if (!min.includes("*") && !min.includes("/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Hourly at :${min.padStart(2, "0")}`;
  }

  // Fixed hour + minute, figure out frequency
  if (!min.includes("*") && !min.includes("/") && !hour.includes("*") && !hour.includes("/")) {
    const time = fmtTime(hour, min);

    // Daily: H M * * *
    if (dom === "*" && mon === "*" && dow === "*") {
      return `Daily at ${time}`;
    }

    // Weekly: H M * * DOW
    if (dom === "*" && mon === "*" && dow !== "*") {
      const dayNames = dow.split(",").map((d) => days[d.trim()] || d).join(", ");
      return `${dayNames} at ${time}`;
    }

    // Monthly: H M DOM * *
    if (dom !== "*" && mon === "*" && dow === "*") {
      const suffix = (d) => { const n = parseInt(d); const s = ["th","st","nd","rd"]; return n + (s[(n%100-20)%10] || s[n%100] || s[0]); };
      const dayList = dom.split(",").map(suffix).join(", ");
      return `${dayList} of month at ${time}`;
    }

    // Yearly: H M DOM MON *
    if (dom !== "*" && mon !== "*" && dow === "*") {
      const suffix = (d) => { const n = parseInt(d); const s = ["th","st","nd","rd"]; return n + (s[(n%100-20)%10] || s[n%100] || s[0]); };
      const monName = months[parseInt(mon)] || mon;
      return `${monName} ${suffix(dom)} at ${time}`;
    }
  }

  return expr;
}

// --- Scheduled Tasks (Cron) ---
let cronEditingName = null;

async function fetchCron() {
  try {
    const res = await apiFetch("/api/cron");
    const jobs = await res.json();
    const tbody = document.getElementById("cron-body");

    if (jobs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">No scheduled tasks</td></tr>';
      return;
    }

    tbody.innerHTML = jobs
      .map((j) => {
        const statusDot = j.lastError
          ? '<span class="cron-status-dot error"></span>Error'
          : j.lastRun
            ? '<span class="cron-status-dot ok"></span>OK'
            : '<span class="cron-status-dot idle"></span>Idle';

        const lastRun = j.lastRun ? `${formatDateTime(j.lastRun)} <span class="muted">(${timeAgo(j.lastRun)})</span>` : "--";
        const nextRun = j.nextRun ? `${formatDateTime(j.nextRun)} <span class="muted">(${timeUntil(j.nextRun)})</span>` : "--";

        return `
          <tr${j.enabled ? "" : ' class="disabled-row"'}>
            <td><code>${esc(j.name)}</code></td>
            <td title="${esc(j.schedule)}">${cronToHuman(j.schedule)}</td>
            <td>${esc(j.type)}</td>
            <td>${j.enabled ? '<span class="ok">Yes</span>' : '<span class="error">No</span>'}</td>
            <td>${lastRun}</td>
            <td>${j.enabled ? nextRun : "--"}</td>
            <td>${statusDot}</td>
            <td>
              <button class="btn btn-xs" onclick="toggleCronJob('${esc(j.name)}')">${j.enabled ? "Disable" : "Enable"}</button>
              <button class="btn btn-xs" onclick="triggerCronJob('${esc(j.name)}')">Run</button>
              <button class="btn btn-xs" onclick="showCronHistory('${esc(j.name)}')">History</button>
              <button class="btn btn-xs" onclick="editCronJob('${esc(j.name)}')">Edit</button>
              <button class="btn btn-danger btn-xs" onclick="deleteCronJob('${esc(j.name)}')">Delete</button>
            </td>
          </tr>`;
      })
      .join("");
  } catch {
    /* ignore */
  }
}

async function toggleCronJob(name) {
  try {
    const res = await apiFetch(`/api/cron/${encodeURIComponent(name)}/toggle`, { method: "POST" });
    const data = await res.json();

    if (data.error) {
      showToast(`Toggle failed: ${data.error}`, "error");
    } else {
      showToast(`Task "${name}" is now ${data.enabled ? "enabled" : "disabled"}`);
      fetchCron();
    }
  } catch (err) {
    showToast(`Toggle error: ${err.message}`, "error");
  }
}

async function triggerCronJob(name) {
  showToast(`Running "${name}"...`);

  try {
    const res = await apiFetch(`/api/cron/${encodeURIComponent(name)}/trigger`, { method: "POST" });
    const data = await res.json();

    if (data.success) {
      showToast(`Task "${name}" completed`);
    } else {
      showToast(`Task "${name}" failed: ${data.error}`, "error");
    }
    fetchCron();
  } catch (err) {
    showToast(`Trigger error: ${err.message}`, "error");
  }
}

async function deleteCronJob(name) {
  if (!confirm(`Delete scheduled task "${name}"?`)) return;

  try {
    const res = await apiFetch(`/api/cron/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await res.json();

    if (data.success) {
      showToast(`Task "${name}" deleted`);
      fetchCron();
      hideCronHistory();
    } else {
      showToast(`Delete failed: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`Delete error: ${err.message}`, "error");
  }
}

async function editCronJob(name) {
  try {
    const res = await apiFetch("/api/cron");
    const jobs = await res.json();
    const job = jobs.find((j) => j.name === name);

    if (!job) {
      showToast(`Job "${name}" not found`, "error");
      return;
    }

    cronEditingName = name;

    // Populate form fields
    document.getElementById("cron-f-name").value = job.name;
    document.getElementById("cron-f-name").disabled = true;
    document.getElementById("cron-f-schedule").value = job.schedule;
    document.getElementById("cron-f-timezone").value = job.timezone || "";
    document.getElementById("cron-f-channel").value = job.channelId;
    document.getElementById("cron-f-type").value = job.type;
    document.getElementById("cron-f-prompt").value = job.prompt || "";
    document.getElementById("cron-f-message").value = job.message || "";
    document.getElementById("cron-f-submit-btn").textContent = "Save";

    // Try to parse cron into the visual builder, fall back to custom
    if (!parseCronToBuilder(job.schedule)) {
      document.getElementById("cron-f-freq").value = "custom";
    }
    updateCronSchedule();
    toggleCronFormFields();

    document.getElementById("cron-form").style.display = "";
  } catch (err) {
    showToast(`Edit error: ${err.message}`, "error");
  }
}

// --- Cron form ---

function showCronForm() {
  document.getElementById("cron-form").style.display = "";
}

function hideCronForm() {
  cronEditingName = null;
  document.getElementById("cron-form").style.display = "none";
  document.getElementById("cron-f-name").value = "";
  document.getElementById("cron-f-name").disabled = false;
  document.getElementById("cron-f-schedule").value = "";
  document.getElementById("cron-f-timezone").value = "";
  document.getElementById("cron-f-channel").value = "";
  document.getElementById("cron-f-type").value = "llm";
  document.getElementById("cron-f-prompt").value = "";
  document.getElementById("cron-f-message").value = "";
  document.getElementById("cron-f-submit-btn").textContent = "Create";
  // Reset schedule builder
  document.getElementById("cron-f-freq").value = "daily";
  document.getElementById("cron-f-time").value = "09:00";
  document.getElementById("cron-f-interval").value = "5";
  document.getElementById("cron-f-dow").value = "1";
  document.getElementById("cron-f-dom").value = "1";
  updateCronSchedule();
  toggleCronFormFields();
}

function toggleCronFormFields() {
  const type = document.getElementById("cron-f-type").value;
  document.getElementById("cron-f-prompt-row").style.display = type === "llm" ? "" : "none";
  document.getElementById("cron-f-message-row").style.display = type === "static" ? "" : "none";
}

// --- Schedule builder ---

function updateCronSchedule() {
  const freq = document.getElementById("cron-f-freq").value;
  const timeVal = document.getElementById("cron-f-time").value || "09:00";
  const interval = document.getElementById("cron-f-interval").value;
  const dow = document.getElementById("cron-f-dow").value;
  const dom = document.getElementById("cron-f-dom").value;

  // Show/hide fields based on frequency
  const showTime = ["daily", "weekly", "monthly"].includes(freq);
  const showInterval = ["minutes", "hours"].includes(freq);
  document.getElementById("cron-f-time-wrap").style.display = showTime ? "" : "none";
  document.getElementById("cron-f-interval-wrap").style.display = showInterval ? "" : "none";
  document.getElementById("cron-f-dow-wrap").style.display = freq === "weekly" ? "" : "none";
  document.getElementById("cron-f-dom-wrap").style.display = freq === "monthly" ? "" : "none";
  document.getElementById("cron-f-interval-unit").textContent = freq === "minutes" ? "min" : "hr";

  // Toggle between preview (visual) and raw input (custom)
  const isCustom = freq === "custom";
  document.getElementById("cron-f-schedule-preview").style.display = isCustom ? "none" : "";
  document.getElementById("cron-f-schedule-human").style.display = isCustom ? "none" : "";
  document.getElementById("cron-f-schedule").style.display = isCustom ? "" : "none";

  if (isCustom) {
    updateCronPreviewFromCustom();
    return;
  }

  // Parse time input
  const [hStr, mStr] = timeVal.split(":");
  const h = parseInt(hStr) || 0;
  const m = parseInt(mStr) || 0;
  const iv = parseInt(interval) || 1;
  let cron;

  switch (freq) {
    case "minutes": cron = `*/${iv} * * * *`; break;
    case "hours":   cron = `0 */${iv} * * *`; break;
    case "daily":   cron = `${m} ${h} * * *`; break;
    case "weekly":  cron = `${m} ${h} * * ${dow}`; break;
    case "monthly": cron = `${m} ${h} ${dom} * *`; break;
  }

  document.getElementById("cron-f-schedule-preview").textContent = cron;
  document.getElementById("cron-f-schedule-human").textContent = cronToHuman(cron);
  document.getElementById("cron-f-schedule").value = cron;
}

function updateCronPreviewFromCustom() {
  const raw = document.getElementById("cron-f-schedule").value.trim();
  const human = document.getElementById("cron-f-schedule-human");
  if (raw) {
    human.textContent = cronToHuman(raw);
    human.style.display = "";
  } else {
    human.style.display = "none";
  }
}

// Parse a cron expression back into the schedule builder fields
function parseCronToBuilder(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [min, hour, dom, mon, dow] = parts;

  // Every N minutes
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    document.getElementById("cron-f-freq").value = "minutes";
    document.getElementById("cron-f-interval").value = min.slice(2);
    return true;
  }
  // Every N hours
  if (min === "0" && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    document.getElementById("cron-f-freq").value = "hours";
    document.getElementById("cron-f-interval").value = hour.slice(2);
    return true;
  }

  // Fixed time patterns
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const h = parseInt(hour);
    const m = parseInt(min);
    document.getElementById("cron-f-time").value =
      `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

    // Daily
    if (dom === "*" && mon === "*" && dow === "*") {
      document.getElementById("cron-f-freq").value = "daily";
      return true;
    }
    // Weekly
    if (dom === "*" && mon === "*" && /^\d$/.test(dow)) {
      document.getElementById("cron-f-freq").value = "weekly";
      document.getElementById("cron-f-dow").value = dow;
      return true;
    }
    // Monthly
    if (/^\d+$/.test(dom) && mon === "*" && dow === "*") {
      document.getElementById("cron-f-freq").value = "monthly";
      document.getElementById("cron-f-dom").value = dom;
      return true;
    }
  }

  return false;
}

async function submitCronJob() {
  const isEdit = cronEditingName !== null;
  const body = {
    name: document.getElementById("cron-f-name").value.trim(),
    schedule: document.getElementById("cron-f-schedule").value.trim(),
    timezone: document.getElementById("cron-f-timezone").value.trim() || undefined,
    channelId: document.getElementById("cron-f-channel").value.trim(),
    type: document.getElementById("cron-f-type").value,
  };

  if (body.type === "llm") {
    body.prompt = document.getElementById("cron-f-prompt").value.trim();
  } else {
    body.message = document.getElementById("cron-f-message").value.trim();
  }

  if (!isEdit && (!body.name || !body.schedule || !body.channelId)) {
    showToast("Name, schedule, and channel ID are required", "error");
    return;
  }
  if (isEdit && (!body.schedule || !body.channelId)) {
    showToast("Schedule and channel ID are required", "error");
    return;
  }

  try {
    const url = isEdit
      ? `/api/cron/${encodeURIComponent(cronEditingName)}`
      : "/api/cron";
    const res = await apiFetch(url, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.success) {
      showToast(`Task "${isEdit ? cronEditingName : body.name}" ${isEdit ? "updated" : "created"}`);
      hideCronForm();
      fetchCron();
    } else {
      showToast(`${isEdit ? "Update" : "Create"} failed: ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`${isEdit ? "Update" : "Create"} error: ${err.message}`, "error");
  }
}

// --- Cron history ---

async function showCronHistory(name) {
  try {
    const res = await apiFetch("/api/cron");
    const jobs = await res.json();
    const job = jobs.find((j) => j.name === name);

    if (!job) {
      showToast(`Job "${name}" not found`, "error");
      return;
    }

    const panel = document.getElementById("cron-history");
    const title = document.getElementById("cron-history-title");
    const body = document.getElementById("cron-history-body");

    title.textContent = `History: ${name}`;
    panel.style.display = "";

    if (!job.history || job.history.length === 0) {
      body.innerHTML = '<span class="muted">No execution history yet</span>';
      return;
    }

    body.innerHTML = job.history
      .slice()
      .reverse()
      .map((h) => {
        const dot = h.success
          ? '<span class="cron-status-dot ok"></span>'
          : '<span class="cron-status-dot error"></span>';

        return `
          <div class="cron-history-entry">
            ${dot}
            <span class="cron-history-time">${formatTime(h.timestamp)}</span>
            <span class="cron-history-duration">${h.durationMs}ms</span>
            <span class="cron-history-output">${esc(h.error || h.outputPreview)}</span>
          </div>`;
      })
      .join("");
  } catch (err) {
    showToast(`History error: ${err.message}`, "error");
  }
}

function hideCronHistory() {
  document.getElementById("cron-history").style.display = "none";
}

// --- Reboot ---

async function rebootBot() {
  if (!confirm("Reboot the bot?")) return;

  const btn = document.getElementById("reboot-btn");
  btn.disabled = true;
  btn.textContent = "Rebooting...";

  try {
    await apiFetch("/api/reboot", { method: "POST" });
    showToast("Reboot initiated", "success");
  } catch (err) {
    showToast(`Reboot failed: ${err.message}`, "error");
    btn.disabled = false;
    btn.textContent = "Reboot";
  }
}

// --- Activity Preview ---

function loadActivityPreview() {
  const btn = document.getElementById("activity-load-btn");
  const wrap = document.getElementById("activity-frame-wrap");
  const frame = document.getElementById("activity-frame");

  btn.style.display = "none";
  wrap.style.display = "";
  frame.src = "/activity/test.html";
}

// --- Init ---
checkAuth();
fetchStatus();
fetchConfig();
fetchSessions();
fetchMemory();
fetchCron();
fetchPersonas();
fetchPersona();
fetchTools();
fetchHeartbeat();
initConsole();

setInterval(fetchStatus, 5000);
setInterval(fetchSessions, 10000);
setInterval(fetchMemory, 10000);
setInterval(fetchCron, 10000);
setInterval(fetchTools, 10000);
setInterval(fetchHeartbeat, 10000);
