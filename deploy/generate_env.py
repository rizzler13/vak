import boto3
from pathlib import Path

def main():
    print("Fetching SSM parameters for vāk...")
    try:
        client = boto3.client('ssm', region_name='us-east-1')
        response = client.get_parameters_by_path(Path='/vak', WithDecryption=True)
        params = {}
        for param in response.get('Parameters', []):
            name = param['Name'].split('/')[-1]
            params[name] = param['Value']
        
        env_content = f"""GROQ_API_KEY={params.get('GROQ_API_KEY', '')}
DEEPGRAM_API_KEY={params.get('DEEPGRAM_API_KEY', '')}
CARTESIA_API_KEY={params.get('CARTESIA_API_KEY', '')}
CEREBRAS_API_KEY={params.get('CEREBRAS_API_KEY', '')}
OPENROUTER_API_KEY={params.get('OPENROUTER_API_KEY', '')}

# AWS
AWS_REGION=us-east-1
AWS_S3_BUCKET=vak-session-history
AWS_S3_PREFIX=vak/

# Server
HOST=0.0.0.0
PORT=8000

# TTS
USE_LOCAL_TTS=true
ENVIRONMENT=production
ALLOWED_ORIGINS=["http://localhost:8000","http://127.0.0.1:8000","http://localhost:3000","http://127.0.0.1:3000","https://d3bxrzk8mr4zou.cloudfront.net"]
"""
        env_path = Path(__file__).resolve().parent.parent / ".env"
        env_path.write_text(env_content)
        print(f"Saved environment configuration to {env_path}")
    except Exception as e:
        print(f"Failed to fetch parameters: {e}")
        raise

if __name__ == "__main__":
    main()
