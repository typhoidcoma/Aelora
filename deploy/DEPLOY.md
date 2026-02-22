# Deploying Aelora to a Linux VPS

## Prerequisites

- **Node.js 22+** — install via [NodeSource](https://github.com/nodesource/distributions) or [nvm](https://github.com/nvm-sh/nvm)
- **Git** — to clone the repo
- A Discord bot token and LLM API key ready

## 1. Create a system user

```bash
sudo useradd --system --shell /usr/sbin/nologin --create-home --home-dir /opt/aelora aelora
```

## 2. Clone and build

```bash
sudo -u aelora git clone https://github.com/YOUR_USER/aelora.git /opt/aelora
cd /opt/aelora
sudo -u aelora npm ci --omit=dev
sudo -u aelora npm run build
```

## 3. Configure

### settings.yaml (non-secret config)

```bash
sudo -u aelora cp settings.example.yaml settings.yaml
sudo -u aelora nano settings.yaml
```

Fill in non-secret values: `guildMode`, `allowedChannels`, `model`, `persona` settings, etc. You can put secrets here too, but the env file is preferred for production.

### Environment file (secrets)

```bash
sudo mkdir -p /etc/aelora
sudo cp deploy/env.example /etc/aelora/env
sudo nano /etc/aelora/env
```

Fill in your secrets (`AELORA_DISCORD_TOKEN`, `AELORA_LLM_API_KEY`, etc.). Then lock down permissions:

```bash
sudo chown root:aelora /etc/aelora/env
sudo chmod 0640 /etc/aelora/env
```

Environment variables override the corresponding `settings.yaml` values. See `deploy/env.example` for the full list.

## 4. Install the systemd service

```bash
sudo cp /opt/aelora/deploy/aelora.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aelora
```

## 5. Verify

```bash
# Check status
sudo systemctl status aelora

# Follow logs
sudo journalctl -u aelora -f

# Check the web dashboard (if enabled)
curl http://localhost:3000/api/status
```

## Updating

```bash
cd /opt/aelora
sudo -u aelora git pull
sudo -u aelora npm ci --omit=dev
sudo -u aelora npm run build
sudo systemctl restart aelora
```

## Node path

The service file assumes Node is at `/usr/bin/node`. If you installed via nvm or fnm, the path will differ. Find it with:

```bash
which node
```

Then update `ExecStart` in `/etc/systemd/system/aelora.service` and run `sudo systemctl daemon-reload`.

## Useful commands

```bash
sudo systemctl stop aelora       # Stop the bot
sudo systemctl start aelora      # Start the bot
sudo systemctl restart aelora    # Restart the bot
sudo journalctl -u aelora -n 50  # Last 50 log lines
sudo journalctl -u aelora -f     # Follow logs live
```

## How restarts work

The bot has two layers of restart protection:

1. **boot.ts** (inner) — supervises the main process. Handles reboot commands (exit code 100) and crash recovery (3s delay, gives up after 3 crashes in 60s).
2. **systemd** (outer) — safety net. Only restarts if boot.ts itself crashes (`Restart=on-failure`, 10s delay).

When you run `/reboot` from Discord, boot.ts handles it instantly. If something goes catastrophically wrong and boot.ts gives up, systemd picks it back up after 10 seconds.

## Data directory

All runtime data lives in `/opt/aelora/data/`:
- `state.json` — shutdown context (consumed on startup)
- `memory.json` — persistent memory facts
- `sessions.json` — conversation analytics
- `cron-jobs.json` — scheduled tasks
- `notes.json` — user notes
- `calendar-notified.json` — calendar reminder dedup
- `memory/logs/` — daily conversation logs
- `memory/summaries.json` — conversation summaries

This directory persists across restarts and updates. Back it up periodically.
