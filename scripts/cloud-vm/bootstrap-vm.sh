#!/usr/bin/env bash
# Run ON THE VM (Ubuntu 24.04) as your normal user — not root. Idempotent:
# safe to re-run; each step is skipped once done.
#
#   bash ~/bootstrap-vm.sh
#
# Runs in two passes because the docker group only takes effect after a
# fresh login:
#   pass 1: system packages, Tailscale, Docker, Node 22, gh  → log out + back in
#   pass 2: clone repo, prefill .env, hand off to `bash nanoclaw.sh`
#
# Optional env vars:
#   REPO=jeffreykthomas/nanoclaw-golf   BRANCH=golf   DEST=~/nanoclaw-golf
#   CLOUDFLARE_TUNNEL_TOKEN=...   install cloudflared as a service with this
#                                 token (Zero Trust → Tunnels → personal-golf-coach
#                                 → Install connector). Only do this while the Mac
#                                 is offline — two connectors split traffic.
set -euo pipefail

REPO="${REPO:-jeffreykthomas/nanoclaw-golf}"
BRANCH="${BRANCH:-golf}"
DEST="${DEST:-$HOME/nanoclaw-golf}"
TS_HOSTNAME="${TS_HOSTNAME:-mentors-claw}"
COACH_APP_PORT="${COACH_APP_PORT:-4317}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run as your normal user (not root); the script uses sudo where needed." >&2
  exit 1
fi

# ── Pass 1: system setup ────────────────────────────────────────────────

say "Base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates build-essential python3 jq

if ! command -v tailscale >/dev/null 2>&1; then
  say "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  say "Joining Tailscale — open the login link below to approve"
  sudo tailscale up --ssh --hostname="$TS_HOSTNAME"
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//; s/\..*//')" -lt 22 ]; then
  say "Installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

if ! command -v gh >/dev/null 2>&1; then
  say "Installing GitHub CLI (for cloning the private repo)"
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq gh
fi

# Keep the user systemd manager (and the NanoClaw service) alive after logout.
sudo loginctl enable-linger "$USER"

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] && ! systemctl is-active --quiet cloudflared; then
  say "Installing cloudflared tunnel connector"
  curl -fsSL -o /tmp/cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i /tmp/cloudflared.deb
  sudo cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"
fi

# The docker group only applies to new login sessions (including the user
# systemd manager that will run NanoClaw), so stop here on the first pass.
if ! id -nG | tr ' ' '\n' | grep -qx docker; then
  say "Pass 1 done."
  cat <<MSG
Docker group membership needs a fresh login. Now:
  1. exit
  2. reconnect (from the laptop: ssh $TS_HOSTNAME   — or gcloud compute ssh again)
  3. bash ~/bootstrap-vm.sh
MSG
  # Restart the user systemd manager so it also picks up the docker group.
  sudo systemctl restart "user@$(id -u).service" 2>/dev/null || true
  exit 0
fi

# ── Pass 2: NanoClaw ────────────────────────────────────────────────────

if [ ! -d "$DEST/.git" ]; then
  if ! gh auth status >/dev/null 2>&1; then
    say "GitHub login (device code — open the URL on your laptop/phone)"
    gh auth login --hostname github.com --git-protocol https --web
  fi
  gh auth setup-git
  say "Cloning $REPO ($BRANCH) → $DEST"
  gh repo clone "$REPO" "$DEST" -- --branch "$BRANCH"
else
  say "Repo already at $DEST — pulling latest $BRANCH"
  git -C "$DEST" fetch origin "$BRANCH"
  git -C "$DEST" checkout "$BRANCH"
  git -C "$DEST" pull --ff-only origin "$BRANCH"
fi

cd "$DEST"

# Seed .env with the coach bridge settings the Mac uses; secrets are added
# by hand afterwards (see the checklist printed at the end).
touch .env
set_env() {
  grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env
}
grep -q '^ENABLE_COACH_AGENT=' .env || set_env ENABLE_COACH_AGENT true
grep -q '^APP_PORT=' .env || set_env APP_PORT "$COACH_APP_PORT"

say "Handing off to nanoclaw.sh (Node deps, OneCLI, Claude auth, container build, Telegram, systemd service)"
bash nanoclaw.sh || {
  echo
  echo "nanoclaw.sh exited non-zero — fix the reported step and re-run: cd $DEST && bash nanoclaw.sh"
  exit 1
}

say "Done. Remaining manual steps:"
cat <<MSG
  • Add the secrets that live outside git to $DEST/.env (compare against .env.example):
      ARCCOS_EMAIL / ARCCOS_PASSWORD, COACH_GOOGLE_SERVICE_ACCOUNT_JSON,
      BIPBOT_GATEWAY_URL / BIPBOT_GATEWAY_TOKEN, BIPBOT_FIREBASE_SERVICE_ACCOUNT_PATH, ...
    then: systemctl --user restart \$(systemctl --user list-units --type=service --no-legend | awk '/nanoclaw/{print \$1}')
  • Recreate the scheduled tasks that matter; paste in per-chat memory not in git.
  • Health:  curl -s localhost:$COACH_APP_PORT/health ; tail -f $DEST/logs/nanoclaw.log
  • Before the Mac comes back:  systemctl --user stop <nanoclaw unit>  (only one Telegram poller at a time)
MSG
