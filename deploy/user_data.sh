#!/bin/bash
# ═══════════════════════════════════════════════
# vāk — EC2 User Data Bootstrap Script
# Runs on first launch of a fresh Amazon Linux 2023 instance
# ═══════════════════════════════════════════════
set -euo pipefail

LOG_FILE="/var/log/vak-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "═══ vāk Bootstrap — $(date) ═══"

# ── 1. System updates ──
echo ">>> Installing system dependencies..."
dnf update -y
dnf install -y python3.11 python3.11-pip python3.11-devel git gcc

# ── 2. Create app user ──
echo ">>> Creating vak user..."
useradd -m -s /bin/bash vak || true

# ── 3. Clone / deploy code ──
echo ">>> Deploying vāk code..."
APP_DIR="/home/vak/app"
if [ -d "$APP_DIR" ]; then
    cd "$APP_DIR" && git pull origin main || true
else
    # Clone from git
    git clone https://github.com/rizzler13/vak.git "$APP_DIR"
fi

chown -R vak:vak "$APP_DIR"

# ── 4. Install Python dependencies ──
echo ">>> Installing Python dependencies..."
cd "$APP_DIR/backend"
python3.11 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# ── 5. Create .env from SSM Parameter Store ──
echo ">>> Loading environment variables from SSM..."
ENV_FILE="$APP_DIR/.env"
/home/vak/app/backend/.venv/bin/python3 "$APP_DIR/deploy/generate_env.py"

chown vak:vak "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── 6. Install systemd service ──
echo ">>> Installing systemd service..."
cp "$APP_DIR/deploy/vak.service" /etc/systemd/system/vak.service
systemctl daemon-reload
systemctl enable vak
systemctl start vak

echo "═══ vāk Bootstrap Complete — $(date) ═══"
echo ">>> Service status:"
systemctl status vak --no-pager || true
