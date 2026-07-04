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

# Set python3.11 as default
alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1
alternatives --set python3 /usr/bin/python3.11

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
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt

# ── 5. Create .env from SSM Parameter Store ──
echo ">>> Loading environment variables from SSM..."
ENV_FILE="$APP_DIR/.env"

# Fetch secrets from SSM Parameter Store (encrypted)
get_ssm_param() {
    aws ssm get-parameter --name "$1" --with-decryption --query "Parameter.Value" --output text --region us-east-1 2>/dev/null || echo ""
}

cat > "$ENV_FILE" << EOF
GROQ_API_KEY=$(get_ssm_param "/vak/GROQ_API_KEY")
DEEPGRAM_API_KEY=$(get_ssm_param "/vak/DEEPGRAM_API_KEY")
CARTESIA_API_KEY=$(get_ssm_param "/vak/CARTESIA_API_KEY")
CEREBRAS_API_KEY=$(get_ssm_param "/vak/CEREBRAS_API_KEY")
OPENROUTER_API_KEY=$(get_ssm_param "/vak/OPENROUTER_API_KEY")

# AWS — uses IAM Instance Role, no keys needed
AWS_REGION=us-east-1
AWS_S3_BUCKET=vak-session-history
AWS_S3_PREFIX=vak/

# Server
HOST=0.0.0.0
PORT=8000

# TTS — local Kokoro (free, uses CPU)
USE_LOCAL_TTS=true
ENVIRONMENT=production
EOF

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
