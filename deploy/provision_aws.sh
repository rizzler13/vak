#!/bin/bash
# ═══════════════════════════════════════════════
# vāk — Full AWS Provisioning Script
# Creates all AWS infrastructure for free-tier deployment
#
# Prerequisites:
#   - AWS CLI (via python3 -m awscli) credentials configured in environment or .env
#   - Region: us-east-1
#
# Usage: ./provision_aws.sh
# ═══════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load credentials from .env if present
if [ -f "$SCRIPT_DIR/../.env" ]; then
    echo ">>> Loading AWS credentials from .env file..."
    # Export specific AWS variables only
    export AWS_ACCESS_KEY_ID=$(grep -E "^AWS_ACCESS_KEY_ID=" "$SCRIPT_DIR/../.env" | cut -d'=' -f2- | cut -d'#' -f1 | tr -d ' ')
    export AWS_SECRET_ACCESS_KEY=$(grep -E "^AWS_SECRET_ACCESS_KEY=" "$SCRIPT_DIR/../.env" | cut -d'=' -f2- | cut -d'#' -f1 | tr -d ' ')
    export AWS_REGION=$(grep -E "^AWS_REGION=" "$SCRIPT_DIR/../.env" | cut -d'=' -f2- | cut -d'#' -f1 | tr -d ' ')
fi

# Wrapper to avoid broken brew aws command issues on mac
aws() {
    python3 -m awscli "$@"
}

REGION="${AWS_REGION:-us-east-1}"
APP_NAME="vak"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "═══ vāk AWS Provisioning ═══"
echo "  Account: $ACCOUNT_ID"
echo "  Region:  $REGION"
echo ""

# ── 1. Create IAM Role for EC2 ──
echo ">>> [1/7] Creating IAM Role for EC2..."

# Trust policy — allows EC2 to assume this role
cat > /tmp/vak-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role (skip if exists)
aws iam create-role \
    --role-name vak-ec2-role \
    --assume-role-policy-document file:///tmp/vak-trust-policy.json \
    --description "vāk EC2 instance role — S3 + SSM access" \
    --region "$REGION" 2>/dev/null || echo "  Role already exists, continuing..."

# Attach S3 access policy
aws iam attach-role-policy \
    --role-name vak-ec2-role \
    --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess 2>/dev/null || true

# Attach SSM read access (for fetching secrets)
aws iam attach-role-policy \
    --role-name vak-ec2-role \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess 2>/dev/null || true

# Create instance profile
aws iam create-instance-profile \
    --instance-profile-name vak-ec2-profile \
    --region "$REGION" 2>/dev/null || echo "  Instance profile already exists..."

aws iam add-role-to-instance-profile \
    --instance-profile-name vak-ec2-profile \
    --role-name vak-ec2-role 2>/dev/null || echo "  Role already attached..."

echo "  ✓ IAM Role: vak-ec2-role"

# ── 2. Create Security Group ──
echo ">>> [2/7] Creating Security Group..."

# Get default VPC
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text --region "$REGION")
echo "  Default VPC: $VPC_ID"

SG_ID=$(aws ec2 create-security-group \
    --group-name vak-sg \
    --description "vak security group - HTTP 8000 + SSH" \
    --vpc-id "$VPC_ID" \
    --query "GroupId" \
    --output text \
    --region "$REGION" 2>/dev/null || aws ec2 describe-security-groups --filters "Name=group-name,Values=vak-sg" --query "SecurityGroups[0].GroupId" --output text --region "$REGION")

# Inbound rules
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 8000 --cidr 0.0.0.0/0 --region "$REGION" 2>/dev/null || true
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr 0.0.0.0/0 --region "$REGION" 2>/dev/null || true

echo "  ✓ Security Group: $SG_ID"

# ── 3. Create Key Pair ──
echo ">>> [3/7] Creating Key Pair..."

KEY_FILE="$HOME/.ssh/vak-ec2-key.pem"
mkdir -p "$HOME/.ssh"
if [ ! -f "$KEY_FILE" ]; then
    aws ec2 create-key-pair \
        --key-name vak-ec2-key \
        --query "KeyMaterial" \
        --output text \
        --region "$REGION" > "$KEY_FILE"
    chmod 400 "$KEY_FILE"
    echo "  ✓ Key pair saved: $KEY_FILE"
else
    echo "  Key file already exists: $KEY_FILE"
fi

# ── 4. Launch EC2 Instance ──
echo ">>> [4/7] Launching EC2 t3.micro..."

# Get latest Amazon Linux 2023 AMI
AMI_ID=$(aws ec2 describe-images \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
    --query "Images | sort_by(@, &CreationDate) | [-1].ImageId" \
    --output text \
    --region "$REGION")
echo "  AMI: $AMI_ID"

# Read user data script
USER_DATA_FILE="$SCRIPT_DIR/user_data.sh"

# Wait for instance profile to propagate (IAM is eventually consistent)
echo "  Waiting for IAM propagation (10s)..."
sleep 10

INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type t3.micro \
    --key-name vak-ec2-key \
    --security-group-ids "$SG_ID" \
    --iam-instance-profile Name=vak-ec2-profile \
    --user-data "file://$USER_DATA_FILE" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":20,\"VolumeType\":\"gp3\"}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=vak-server}]" \
    --query "Instances[0].InstanceId" \
    --output text \
    --region "$REGION")

echo "  ✓ Instance launched: $INSTANCE_ID"
echo "  Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

# Get public IP
PUBLIC_IP=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].PublicIpAddress" \
    --output text \
    --region "$REGION")

echo "  ✓ Public IP: $PUBLIC_IP"

# ── 5. Create S3 Frontend Bucket ──
echo ">>> [5/7] Creating S3 frontend bucket..."

FRONTEND_BUCKET="vak-frontend-${ACCOUNT_ID}"
aws s3 mb "s3://$FRONTEND_BUCKET" --region "$REGION" 2>/dev/null || echo "  Bucket already exists..."

# Configure for static website hosting
aws s3 website "s3://$FRONTEND_BUCKET" --index-document index.html --region "$REGION"

echo "  ✓ S3 Bucket: $FRONTEND_BUCKET"

# ── 6. Upload frontend files ──
echo ">>> [6/7] Uploading frontend files..."
FRONTEND_DIR="$SCRIPT_DIR/../web_test"
aws s3 sync "$FRONTEND_DIR" "s3://$FRONTEND_BUCKET" \
    --delete \
    --exclude "check_html.py" \
    --region "$REGION"
echo "  ✓ Frontend uploaded"

# ── 7. Create CloudFront Distribution ──
echo ">>> [7/7] Creating CloudFront distribution..."

# Create Origin Access Control
OAC_ID=$(aws cloudfront create-origin-access-control \
    --origin-access-control-config "{
        \"Name\": \"vak-oac\",
        \"Description\": \"OAC for vak frontend bucket\",
        \"SigningProtocol\": \"sigv4\",
        \"SigningBehavior\": \"always\",
        \"OriginAccessControlOriginType\": \"s3\"
    }" \
    --query "OriginAccessControl.Id" \
    --output text 2>/dev/null || echo "existing")

if [ "$OAC_ID" = "existing" ]; then
    OAC_ID=$(aws cloudfront list-origin-access-controls \
        --query "OriginAccessControlList.Items[?Name=='vak-oac'].Id | [0]" \
        --output text)
fi

echo "  OAC: $OAC_ID"

# Create distribution
DIST_CONFIG=$(cat << DISTEOF
{
    "CallerReference": "vak-$(date +%s)",
    "Comment": "vāk frontend distribution",
    "DefaultCacheBehavior": {
        "TargetOriginId": "vak-s3-origin",
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": 2,
            "Items": ["GET", "HEAD"],
            "CachedMethods": {
                "Quantity": 2,
                "Items": ["GET", "HEAD"]
            }
        },
        "ForwardedValues": {
            "QueryString": false,
            "Cookies": { "Forward": "none" }
        },
        "MinTTL": 0,
        "DefaultTTL": 86400,
        "MaxTTL": 31536000,
        "Compress": true
    },
    "Origins": {
        "Quantity": 1,
        "Items": [
            {
                "Id": "vak-s3-origin",
                "DomainName": "${FRONTEND_BUCKET}.s3.${REGION}.amazonaws.com",
                "OriginAccessControlId": "${OAC_ID}",
                "S3OriginConfig": {
                    "OriginAccessIdentity": ""
                }
            }
        ]
    },
    "DefaultRootObject": "index.html",
    "Enabled": true,
    "PriceClass": "PriceClass_100"
}
DISTEOF
)

DIST_ID=$(aws cloudfront create-distribution \
    --distribution-config "$DIST_CONFIG" \
    --query "Distribution.Id" \
    --output text 2>/dev/null || echo "error")

if [ "$DIST_ID" = "error" ]; then
    echo "  ⚠ CloudFront distribution creation failed or already exists."
    echo "  You may need to create it manually in the AWS Console."
    DIST_ID="PENDING"
    CF_DOMAIN="PENDING"
else
    CF_DOMAIN=$(aws cloudfront get-distribution \
        --id "$DIST_ID" \
        --query "Distribution.DomainName" \
        --output text)
fi

echo "  ✓ Distribution: $DIST_ID"
echo "  ✓ CloudFront URL: https://$CF_DOMAIN"

# ── Update S3 bucket policy for CloudFront ──
if [ "$DIST_ID" != "PENDING" ]; then
    cat > /tmp/vak-bucket-policy.json << BPEOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowCloudFrontServicePrincipal",
            "Effect": "Allow",
            "Principal": {
                "Service": "cloudfront.amazonaws.com"
            },
            "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::${FRONTEND_BUCKET}/*",
            "Condition": {
                "StringEquals": {
                    "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"
                }
            }
        }
    ]
}
BPEOF

    aws s3api put-bucket-policy \
        --bucket "$FRONTEND_BUCKET" \
        --policy file:///tmp/vak-bucket-policy.json
    echo "  ✓ Bucket policy updated for CloudFront"
fi

# ═══ Summary ═══
echo ""
echo "═══════════════════════════════════════════════"
echo "  vāk AWS Deployment Complete!"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Backend:"
echo "    EC2 Instance:  $INSTANCE_ID"
echo "    Public IP:     $PUBLIC_IP"
echo "    Health Check:  http://$PUBLIC_IP:8000/health"
echo "    SSH:           ssh -i $KEY_FILE ec2-user@$PUBLIC_IP"
echo ""
echo "  Frontend:"
echo "    S3 Bucket:     $FRONTEND_BUCKET"
echo "    CloudFront:    https://$CF_DOMAIN"
echo "    Distribution:  $DIST_ID"
echo ""
echo "  Next Steps:"
echo "    1. Wait ~5-10 min for EC2 bootstrap to complete"
echo "    2. Store API keys in SSM Parameter Store:"
echo "       python3 -m awscli ssm put-parameter --name /vak/GROQ_API_KEY --value 'your-key' --type SecureString"
echo "       python3 -m awscli ssm put-parameter --name /vak/DEEPGRAM_API_KEY --value 'your-key' --type SecureString"
echo "       python3 -m awscli ssm put-parameter --name /vak/CARTESIA_API_KEY --value 'your-key' --type SecureString"
echo "       python3 -m awscli ssm put-parameter --name /vak/CEREBRAS_API_KEY --value 'your-key' --type SecureString"
echo "       python3 -m awscli ssm put-parameter --name /vak/OPENROUTER_API_KEY --value 'your-key' --type SecureString"
echo "    3. SSH into EC2 and restart: sudo systemctl restart vak"
echo "    4. Update CORS in config.py / allowed_origins to include your CloudFront URL: https://$CF_DOMAIN"
echo "    5. Re-deploy frontend: ./deploy/deploy_frontend.sh $FRONTEND_BUCKET $DIST_ID"
echo ""
echo "═══════════════════════════════════════════════"
