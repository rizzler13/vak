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
