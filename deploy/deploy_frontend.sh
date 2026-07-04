#!/bin/bash
# ═══════════════════════════════════════════════
# vāk — Deploy Frontend to S3 + CloudFront
# Usage: ./deploy_frontend.sh [BUCKET_NAME] [DISTRIBUTION_ID]
# ═══════════════════════════════════════════════
set -euo pipefail

BUCKET_NAME="${1:-vak-frontend}"
DISTRIBUTION_ID="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/../web_test"

# Load credentials from .env if present
if [ -f "$SCRIPT_DIR/../.env" ]; then
    export AWS_ACCESS_KEY_ID=$(grep -E "^AWS_ACCESS_KEY_ID=" "$SCRIPT_DIR/../.env" | cut -d'=' -f2- | cut -d'#' -f1 | tr -d ' ')
    export AWS_SECRET_ACCESS_KEY=$(grep -E "^AWS_SECRET_ACCESS_KEY=" "$SCRIPT_DIR/../.env" | cut -d'=' -f2- | cut -d'#' -f1 | tr -d ' ')
    export AWS_REGION=$(grep -E "^AWS_REGION=" "$SCRIPT_DIR/../.env" | cut -d'=' -f2- | cut -d'#' -f1 | tr -d ' ')
fi

# Wrapper to avoid broken brew aws command issues on mac
aws() {
    python3 -m awscli "$@"
}

echo "═══ Deploying vāk frontend ═══"
echo "  Source:  $FRONTEND_DIR"
echo "  Bucket:  s3://$BUCKET_NAME"

# ── 1. Sync frontend files to S3 ──
echo ">>> Syncing files to S3..."
aws s3 sync "$FRONTEND_DIR" "s3://$BUCKET_NAME" \
    --delete \
    --cache-control "public, max-age=31536000" \
    --exclude "*.html" \
    --exclude "check_html.py"

# HTML files — short cache for faster updates
aws s3 sync "$FRONTEND_DIR" "s3://$BUCKET_NAME" \
    --cache-control "public, max-age=300" \
    --include "*.html" \
    --exclude "*" \

echo ">>> Frontend synced to S3."

# ── 2. Invalidate CloudFront cache ──
if [ -n "$DISTRIBUTION_ID" ]; then
    echo ">>> Invalidating CloudFront distribution: $DISTRIBUTION_ID"
    aws cloudfront create-invalidation \
        --distribution-id "$DISTRIBUTION_ID" \
        --paths "/*" \
        --query "Invalidation.Id" \
        --output text
    echo ">>> CloudFront invalidation started."
else
    echo ">>> No CloudFront distribution ID provided, skipping invalidation."
fi

echo "═══ Frontend deploy complete ═══"
