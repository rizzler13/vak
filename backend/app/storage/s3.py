"""
vāk — AWS S3 Isolated Storage

Persists and restores conversation history and user insights to/from an AWS S3 bucket.
Runs synchronously blocking calls inside an executor thread pool.
"""

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
import boto3
from botocore.exceptions import ClientError
from app.config import settings

logger = logging.getLogger("vak.storage")


class S3HistoryStore:
    """
    Manages isolated S3 storage for transcripts and insights.
    Thread-pool executor-based async wrapper for boto3 client.
    """

    def __init__(self):
        from pathlib import Path
        import os
        self.local_dir = Path(__file__).resolve().parent.parent.parent / "data"
        self.sessions_dir = self.local_dir / "sessions"
        self.insights_dir = self.local_dir / "insights"
        self.reports_dir = self.local_dir / "reports"
        
        # Always create these local fallback directories
        os.makedirs(self.sessions_dir, exist_ok=True)
        os.makedirs(self.insights_dir, exist_ok=True)
        os.makedirs(self.reports_dir, exist_ok=True)

        self.bucket_name = settings.aws_s3_bucket
        self.prefix = settings.aws_s3_prefix or "vak/"
        # Ensure prefix ends with a slash for clean nesting
        if not self.prefix.endswith("/"):
            self.prefix += "/"
            
        self.enabled = bool(
            (settings.aws_access_key_id and settings.aws_s3_bucket) or
            (settings.environment == "production" and settings.aws_s3_bucket)
        )

        if not self.enabled:
            logger.warning("AWS credentials or S3 bucket not fully configured. Using local filesystem storage fallback.")
            self.s3_client = None
            self.executor = None
            return

        try:
            logger.info("Initializing S3 Client...")
            client_kwargs = {
                "region_name": settings.aws_region or "us-east-1"
            }
            if settings.aws_access_key_id:
                client_kwargs["aws_access_key_id"] = settings.aws_access_key_id
                client_kwargs["aws_secret_access_key"] = settings.aws_secret_access_key
            
            self.s3_client = boto3.client("s3", **client_kwargs)
            self.executor = ThreadPoolExecutor(max_workers=4)
            self._ensure_bucket_exists()
        except Exception as e:
            logger.error(f"Failed to initialize S3 client: {e}. Falling back to local filesystem storage.", exc_info=True)
            self.enabled = False
            self.s3_client = None
            self.executor = None

    def _ensure_bucket_exists(self):
        """Verify the S3 bucket exists, and attempt to create it if it doesn't."""
        if not self.s3_client:
            return

        try:
            logger.info(f"Checking if S3 bucket '{self.bucket_name}' exists...")
            self.s3_client.head_bucket(Bucket=self.bucket_name)
            logger.info(f"S3 bucket '{self.bucket_name}' verified.")
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code")
            if error_code == "404":
                logger.info(f"S3 bucket '{self.bucket_name}' does not exist. Creating...")
                try:
                    if settings.aws_region and settings.aws_region != "us-east-1":
                        self.s3_client.create_bucket(
                            Bucket=self.bucket_name,
                            CreateBucketConfiguration={"LocationConstraint": settings.aws_region},
                        )
                    else:
                        self.s3_client.create_bucket(Bucket=self.bucket_name)
                    logger.info(f"S3 bucket '{self.bucket_name}' created successfully.")
                except Exception as create_err:
                    logger.error(
                        f"Failed to automatically create S3 bucket '{self.bucket_name}': {create_err}. "
                        "Storage will try to run assuming bucket exists or fall back to memory on error."
                    )
            else:
                logger.error(f"Error checking bucket access: {e}. Storage will proceed but might fail.")

    # ── Session Transcripts (History) ──

    def _load_history_sync(self, session_id: str) -> list[dict]:
        """Synchronous S3 fetch helper for session transcripts."""
        if not self.enabled or not self.s3_client:
            return []

        key = f"{self.prefix}sessions/{session_id}.json"
        try:
            logger.info(f"Fetching session {session_id} history from S3: {key}")
            response = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)
            data = json.loads(response["Body"].read().decode("utf-8"))
            history = data.get("history", [])
            logger.info(f"Successfully loaded {len(history)} messages from S3 for session {session_id}.")
            return history
        except self.s3_client.exceptions.NoSuchKey:
            logger.info(f"No existing history file found for session {session_id} in S3. Starting fresh.")
            return []
        except Exception as e:
            logger.error(f"Failed to load history from S3 for session {session_id}: {e}", exc_info=True)
            return []

    def _load_history_local(self, session_id: str) -> list[dict]:
        """Synchronous local fetch helper for session transcripts."""
        filepath = self.sessions_dir / f"{session_id}.json"
        if not filepath.exists():
            return []
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("history", [])
        except Exception as e:
            logger.error(f"Failed to load local history for session {session_id}: {e}")
            return []

    def _save_history_sync(self, session_id: str, history: list[dict], title: str = ""):
        """Synchronous S3 upload helper for session transcripts."""
        if not self.enabled or not self.s3_client:
            return

        key = f"{self.prefix}sessions/{session_id}.json"
        try:
            logger.info(f"Saving session {session_id} history to S3: {key}")
            # Try to fetch existing history from S3 to preserve title
            existing_title = ""
            if not title:
                try:
                    response = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)
                    old_data = json.loads(response["Body"].read().decode("utf-8"))
                    existing_title = old_data.get("title", "")
                except Exception:
                    pass

            payload = {
                "session_id": session_id,
                "history": history,
                "title": title or existing_title or f"Shift {session_id[:6].upper()}"
            }
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=json.dumps(payload, indent=2).encode("utf-8"),
                ContentType="application/json",
            )
            logger.info(f"Successfully saved session {session_id} history to S3.")
        except Exception as e:
            logger.error(f"Failed to save history to S3 for session {session_id}: {e}", exc_info=True)

    def _save_history_local(self, session_id: str, history: list[dict], title: str = ""):
        """Synchronous local save helper for session transcripts."""
        filepath = self.sessions_dir / f"{session_id}.json"
        try:
            existing_title = ""
            if filepath.exists() and not title:
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        old_data = json.load(f)
                    existing_title = old_data.get("title", "")
                except Exception:
                    pass

            payload = {
                "session_id": session_id,
                "history": history,
                "title": title or existing_title or f"Shift {session_id[:6].upper()}"
            }
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Failed to save local history for session {session_id}: {e}")

    async def load_history(self, session_id: str) -> list[dict]:
        """Asynchronously load session history from S3 or local fallback."""
        loop = asyncio.get_running_loop()
        if self.enabled:
            return await loop.run_in_executor(self.executor, self._load_history_sync, session_id)
        else:
            return await loop.run_in_executor(None, self._load_history_local, session_id)

    async def save_history(self, session_id: str, history: list[dict], title: str = ""):
        """Asynchronously save session history to S3 or local fallback."""
        loop = asyncio.get_running_loop()
        if self.enabled:
            await loop.run_in_executor(self.executor, self._save_history_sync, session_id, history, title)
        else:
            await loop.run_in_executor(None, self._save_history_local, session_id, history, title)

    # ── User Insights (Long-Term Memory) ──

    def _load_insights_sync(self, user_id: str) -> dict:
        """Synchronous S3 fetch helper for user profile insights."""
        if not self.enabled or not self.s3_client:
            return {}

        key = f"{self.prefix}insights/{user_id}.json"
        try:
            logger.info(f"Fetching user insights for {user_id} from S3: {key}")
            response = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)
            data = json.loads(response["Body"].read().decode("utf-8"))
            logger.info(f"Successfully loaded user insights for {user_id} from S3.")
            return data
        except self.s3_client.exceptions.NoSuchKey:
            logger.info(f"No existing user insights profile found for {user_id} in S3. Starting fresh.")
            return {}
        except Exception as e:
            logger.error(f"Failed to load user insights from S3 for {user_id}: {e}", exc_info=True)
            return {}

    def _load_insights_local(self, user_id: str) -> dict:
        """Synchronous local fetch helper for user profile insights."""
        filepath = self.insights_dir / f"{user_id}.json"
        if not filepath.exists():
            return {}
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load local insights for {user_id}: {e}")
            return {}

    def _save_insights_sync(self, user_id: str, insights: dict):
        """Synchronous S3 upload helper for user profile insights."""
        if not self.enabled or not self.s3_client:
            return

        key = f"{self.prefix}insights/{user_id}.json"
        try:
            logger.info(f"Saving user insights for {user_id} to S3: {key}")
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=json.dumps(insights, indent=2).encode("utf-8"),
                ContentType="application/json",
            )
            logger.info(f"Successfully saved user insights for {user_id} to S3.")
        except Exception as e:
            logger.error(f"Failed to save user insights to S3 for {user_id}: {e}", exc_info=True)

    def _save_insights_local(self, user_id: str, insights: dict):
        """Synchronous local save helper for user profile insights."""
        filepath = self.insights_dir / f"{user_id}.json"
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(insights, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Failed to save local insights for {user_id}: {e}")

    async def load_insights(self, user_id: str) -> dict:
        """Asynchronously load user insights from S3 or local fallback."""
        loop = asyncio.get_running_loop()
        if self.enabled:
            return await loop.run_in_executor(self.executor, self._load_insights_sync, user_id)
        else:
            return await loop.run_in_executor(None, self._load_insights_local, user_id)

    async def save_insights(self, user_id: str, insights: dict):
        """Asynchronously save user insights to S3 or local fallback."""
        loop = asyncio.get_running_loop()
        if self.enabled:
            await loop.run_in_executor(self.executor, self._save_insights_sync, user_id, insights)
        else:
            await loop.run_in_executor(None, self._save_insights_local, user_id, insights)

    # ── Session Listing ──

    def _list_sessions_sync(self) -> list[dict]:
        """Synchronous S3 fetch helper to list all past sessions with parallel downloads for titles."""
        if not self.enabled or not self.s3_client:
            return []

        prefix = f"{self.prefix}sessions/"
        try:
            logger.info(f"Listing sessions from S3: {prefix}")
            response = self.s3_client.list_objects_v2(
                Bucket=self.bucket_name,
                Prefix=prefix
            )
            contents = response.get("Contents", [])
            sessions = []

            def get_session_info(obj):
                key = obj["Key"]
                if not key.endswith(".json"):
                    return None
                filename = key[len(prefix):]
                session_id = filename[:-5]
                if not session_id:
                    return None
                last_modified = obj["LastModified"].isoformat()
                title = f"Shift {session_id[:6].upper()}"
                
                try:
                    res = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)
                    data = json.loads(res["Body"].read().decode("utf-8"))
                    title = data.get("title", title)
                except Exception:
                    pass
                
                return {
                    "session_id": session_id,
                    "last_modified": last_modified,
                    "title": title
                }

            if contents:
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                    results = executor.map(get_session_info, contents)
                    for r in results:
                        if r:
                            sessions.append(r)

            # Sort by last_modified descending (newest first)
            sessions.sort(key=lambda x: x["last_modified"], reverse=True)
            logger.info(f"Successfully listed {len(sessions)} sessions from S3.")
            return sessions
        except Exception as e:
            logger.error(f"Failed to list sessions from S3: {e}", exc_info=True)
            return []

    def _list_sessions_local(self) -> list[dict]:
        """Synchronous local listing helper for past sessions."""
        import os
        from datetime import datetime
        sessions = []
        try:
            for filename in os.listdir(self.sessions_dir):
                if not filename.endswith(".json"):
                    continue
                session_id = filename[:-5]
                filepath = self.sessions_dir / filename
                mtime = os.path.getmtime(filepath)
                last_modified = datetime.fromtimestamp(mtime).isoformat()
                
                title = f"Shift {session_id[:6].upper()}"
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    title = data.get("title", title)
                except Exception:
                    pass
                
                sessions.append({
                    "session_id": session_id,
                    "last_modified": last_modified,
                    "title": title
                })
            # Sort by last_modified descending (newest first)
            sessions.sort(key=lambda x: x["last_modified"], reverse=True)
            return sessions
        except Exception as e:
            logger.error(f"Failed to list local sessions: {e}")
            return []

    async def list_sessions(self) -> list[dict]:
        """Asynchronously list past sessions from S3 or local fallback."""
        loop = asyncio.get_running_loop()
        if self.enabled:
            return await loop.run_in_executor(self.executor, self._list_sessions_sync)
        else:
            return await loop.run_in_executor(None, self._list_sessions_local)

    # ── Cognitive focus reports (Cached Whoop Reports) ──

    def _load_report_sync(self, session_id: str) -> dict | None:
        """Synchronous S3 fetch helper for cached cognitive reports."""
        if not self.enabled or not self.s3_client:
            return None

        key = f"{self.prefix}reports/{session_id}.json"
        try:
            logger.info(f"Fetching report for session {session_id} from S3: {key}")
            response = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)
            data = json.loads(response["Body"].read().decode("utf-8"))
            return data
        except self.s3_client.exceptions.NoSuchKey:
            logger.info(f"No existing report found for session {session_id} in S3.")
            return None
        except Exception as e:
            logger.error(f"Failed to load report from S3 for session {session_id}: {e}", exc_info=True)
            return None

    def _load_report_local(self, session_id: str) -> dict | None:
        """Synchronous local fetch helper for focus reports."""
        filepath = self.reports_dir / f"{session_id}.json"
        if not filepath.exists():
            return None
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load local report for session {session_id}: {e}")
            return None

    def _save_report_sync(self, session_id: str, report: dict):
        """Synchronous S3 upload helper for cached cognitive reports."""
        if not self.enabled or not self.s3_client:
            return

        key = f"{self.prefix}reports/{session_id}.json"
        try:
            logger.info(f"Saving report for session {session_id} to S3: {key}")
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=json.dumps(report, indent=2).encode("utf-8"),
                ContentType="application/json",
            )
            logger.info(f"Successfully saved report for session {session_id} to S3.")
        except Exception as e:
            logger.error(f"Failed to save report to S3 for session {session_id}: {e}", exc_info=True)

    def _save_report_local(self, session_id: str, report: dict):
        """Synchronous local save helper for focus reports."""
        filepath = self.reports_dir / f"{session_id}.json"
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Failed to save local report for session {session_id}: {e}")

    async def load_report(self, session_id: str) -> dict | None:
        """Asynchronously load cached focus report from S3 or local fallback."""
        loop = asyncio.get_running_loop()
        if self.enabled:
            return await loop.run_in_executor(self.executor, self._load_report_sync, session_id)
        else:
            return await loop.run_in_executor(None, self._load_report_local, session_id)

    async def save_report(self, session_id: str, report: dict):
        """Asynchronously save focus report to S3 or local fallback."""
        loop = asyncio.get_running_loop()
        if self.enabled:
            await loop.run_in_executor(self.executor, self._save_report_sync, session_id, report)
        else:
            await loop.run_in_executor(None, self._save_report_local, session_id, report)
