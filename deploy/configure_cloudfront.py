import json
import subprocess
import os

DIST_ID = "E2EXXR7T58GEQX"
EC2_IP = "ec2-52-86-214-242.compute-1.amazonaws.com"

def run_cmd(cmd):
    # Retrieve env vars for AWS credentials
    env = os.environ.copy()
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env)
    if res.returncode != 0:
        raise RuntimeError(f"Command failed: {cmd}\nError: {res.stderr}")
    return res.stdout.strip()

def main():
    print("Fetching current CloudFront distribution config...")
    cmd = f"python3 -m awscli cloudfront get-distribution-config --id {DIST_ID} --region us-east-1"
    output = json.loads(run_cmd(cmd))
    
    etag = output["ETag"]
    config = output["DistributionConfig"]
    
    # 1. Add EC2 origin if not present
    origins = config["Origins"]["Items"]
    ec2_origin_id = "vak-ec2-origin"
    has_ec2 = any(o["Id"] == ec2_origin_id for o in origins)
    
    if not has_ec2:
        print("Adding EC2 backend origin...")
        ec2_origin = {
            "Id": ec2_origin_id,
            "DomainName": EC2_IP,
            "OriginPath": "",
            "CustomHeaders": {"Quantity": 0},
            "CustomOriginConfig": {
                "HTTPPort": 8000,
                "HTTPSPort": 443,
                "OriginProtocolPolicy": "http-only",
                "OriginSslProtocols": {
                    "Quantity": 1,
                    "Items": ["TLSv1.2"]
                },
                "OriginReadTimeout": 30,
                "OriginKeepaliveTimeout": 5
            },
            "ConnectionAttempts": 3,
            "ConnectionTimeout": 10,
            "OriginShield": {"Enabled": False}
        }
        origins.append(ec2_origin)
        config["Origins"]["Quantity"] = len(origins)
    
    # 2. Add CacheBehaviors for ws/*, health, and sessions*
    print("Setting up cache behaviors for backend routing...")
    
    behavior_ws = {
        "PathPattern": "ws/*",
        "TargetOriginId": ec2_origin_id,
        "ViewerProtocolPolicy": "allow-all",
        "AllowedMethods": {
            "Quantity": 7,
            "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
            "CachedMethods": {
                "Quantity": 2,
                "Items": ["GET", "HEAD"]
            }
        },
        "SmoothStreaming": False,
        "Compress": True,
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "",
        "ForwardedValues": {
            "QueryString": True,
            "Cookies": {"Forward": "all"},
            "Headers": {
                "Quantity": 1,
                "Items": ["Host"]
            },
            "QueryStringCacheKeys": {"Quantity": 0}
        },
        "MinTTL": 0,
        "DefaultTTL": 0,
        "MaxTTL": 0
    }
    
    behavior_api = {
        "PathPattern": "health",
        "TargetOriginId": ec2_origin_id,
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": 7,
            "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
            "CachedMethods": {
                "Quantity": 2,
                "Items": ["GET", "HEAD"]
            }
        },
        "SmoothStreaming": False,
        "Compress": True,
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "",
        "ForwardedValues": {
            "QueryString": True,
            "Cookies": {"Forward": "all"},
            "Headers": {
                "Quantity": 1,
                "Items": ["*"]
            },
            "QueryStringCacheKeys": {"Quantity": 0}
        },
        "MinTTL": 0,
        "DefaultTTL": 0,
        "MaxTTL": 0
    }
    
    behavior_sessions = {
        "PathPattern": "sessions*",
        "TargetOriginId": ec2_origin_id,
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": 7,
            "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
            "CachedMethods": {
                "Quantity": 2,
                "Items": ["GET", "HEAD"]
            }
        },
        "SmoothStreaming": False,
        "Compress": True,
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "",
        "ForwardedValues": {
            "QueryString": True,
            "Cookies": {"Forward": "all"},
            "Headers": {
                "Quantity": 1,
                "Items": ["*"]
            },
            "QueryStringCacheKeys": {"Quantity": 0}
        },
        "MinTTL": 0,
        "DefaultTTL": 0,
        "MaxTTL": 0
    }
    
    config["CacheBehaviors"] = {
        "Quantity": 3,
        "Items": [behavior_ws, behavior_api, behavior_sessions]
    }
    
    # Save the modified configuration
    with open("dist_config_modified.json", "w") as f:
        json.dump(config, f, indent=2)
        
    print("Uploading updated CloudFront configuration...")
    update_cmd = f'python3 -m awscli cloudfront update-distribution --id {DIST_ID} --if-match {etag} --distribution-config file://dist_config_modified.json --region us-east-1'
    res = run_cmd(update_cmd)
    print("CloudFront distribution updated successfully!")
    
    # Clean up temp file
    if os.path.exists("dist_config_modified.json"):
        os.remove("dist_config_modified.json")

if __name__ == "__main__":
    main()
