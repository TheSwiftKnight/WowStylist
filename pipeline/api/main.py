"""
api/main.py

WowStylist 的 Next.js 會打這支服務。

    Next.js  POST /ingest {"url": "https://instagram.com/p/XXXX/"}
        │
        ├── 立刻回 {"job_id": 42, "status": "queued"}
        │
        └── 背景跑 fashion_retrieval.pipeline.run_instagram_url()
                 └── 每個階段回寫 ingest_jobs.status / stage
                 └── 完成後把單品寫進 IG RDS

前端不用 poll 這支服務 —— job 狀態就在同一個 RDS 的 ingest_jobs 表，
Next.js 直接 SELECT 就好。這支只負責「跑」。

啟動：
    uvicorn api.main:app --reload --port 8000
"""

import os
import sys
from contextlib import asynccontextmanager

try:
    from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel, Field

    from fashion_retrieval import db_writer
    from fashion_retrieval.pipeline import (
        normalize_instagram_url,
        run_instagram_url_safe,
    )

except ModuleNotFoundError as error:
    raise ModuleNotFoundError(
        f"缺少套件 '{error.name}'。\n"
        f"在專案根目錄跑：  npm run pipeline:install\n"
        f"目前用的 python：{sys.executable}"
    ) from error


# ============================================================
# App
# ============================================================

# 服務啟動時先把卡住的 job 收掉。
# Railway 重新部署、容器被回收、本機 Ctrl-C —— 正在跑的 BackgroundTask
# 都會直接消失，job 會永遠停在 running，前端的進度條就一直轉。
@asynccontextmanager
async def lifespan(_app: "FastAPI"):
    try:
        stale = db_writer.fail_stale_jobs(
            older_than_minutes=int(
                os.getenv("STALE_JOB_MINUTES", "30")
            )
        )
        if stale:
            print(f"[startup] 收掉 {stale} 筆重啟前沒跑完的 job")
    except Exception as error:
        print(f"[startup] 清理 job 時出錯（不影響服務）：{error}")

    yield


app = FastAPI(
    title="WowStylist Fashion Pipeline",
    version="1.0.0",
    lifespan=lifespan,
)


# Next.js dev server。上雲之後用 ALLOWED_ORIGINS 覆寫（逗號分隔）。
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 簡單的共享密鑰。Next.js 會帶 x-pipeline-token。
# 沒設就不檢查（本機 dev 方便）。
PIPELINE_TOKEN = os.getenv("PIPELINE_TOKEN")


def check_token(token: str | None) -> None:

    if not PIPELINE_TOKEN:
        return

    if token != PIPELINE_TOKEN:
        raise HTTPException(
            status_code=401,
            detail="invalid pipeline token",
        )


# ============================================================
# Schemas
# ============================================================

class IngestRequest(BaseModel):

    url: str = Field(
        ...,
        description="Instagram Post / Reel 連結",
    )

    source_text: str | None = Field(
        default=None,
        description="使用者傳來的原始訊息全文",
    )

    sender_id: str | None = Field(
        default=None,
        description="LINE userId",
    )

    sender_name: str | None = Field(
        default=None,
        description="LINE 顯示名稱",
    )


class IngestResponse(BaseModel):
    job_id: int
    url: str
    shortcode: str
    status: str


# ============================================================
# Routes
# ============================================================

@app.get("/health")
def health() -> dict:
    """
    看服務活著沒、環境變數有沒有漏、DB 連不連得上。
    Next.js 的設定頁可以打這支。
    """

    required_env = [
        "APIFY_TOKEN",
        "ANTHROPIC_API_KEY",
        "HF_TOKEN",
        "DB_HOST",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
    ]

    missing = [
        key
        for key in required_env
        if not os.getenv(key)
    ]

    db_ok = True
    db_error = None
    columns: list[str] = []
    can_upsert = False

    try:
        table_columns = db_writer.get_table_columns(
            db_writer.FASHION_TABLE
        )
        columns = sorted(table_columns.keys())

        can_upsert = db_writer.has_source_unique_index(
            db_writer.FASHION_TABLE
        )

    except Exception as error:
        db_ok = False
        db_error = str(error)

    # migration 跑完的話這些都該在
    expected = {
        "source",
        "source_item_id",
        "category",
        "text_description",
        "embedding",
        "embedding_model",
        "image_data",
        "image_mime",
    }

    missing_columns = sorted(expected - set(columns)) if columns else []

    return {
        "ok": db_ok and not missing and not missing_columns,
        "missing_env": missing,
        "database": {
            "ok": db_ok,
            "error": db_error,
            "table": db_writer.FASHION_TABLE,
            "columns": columns,
            "missing_columns": missing_columns,
            "can_upsert": can_upsert,
        },
    }


@app.post("/ingest", response_model=IngestResponse)
def ingest(
    body: IngestRequest,
    background_tasks: BackgroundTasks,
    x_pipeline_token: str | None = Header(
        default=None,
        alias="x-pipeline-token",
    ),
) -> IngestResponse:
    """
    收一條 IG 連結，建 job，背景把整條 pipeline 跑完。

    立刻回覆，因為整條跑完要幾十秒到幾分鐘
    （Apify + 每張圖一次 Claude Vision + 每件衣服一次 BGE-M3）。
    """

    check_token(x_pipeline_token)

    try:
        clean_url, shortcode = normalize_instagram_url(
            body.url
        )

    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        )

    job_id = db_writer.create_job(
        url=clean_url,
        source_text=body.source_text,
        sender_id=body.sender_id,
        sender_name=body.sender_name,
    )

    background_tasks.add_task(
        run_instagram_url_safe,
        clean_url,
        job_id=job_id,
        sender_id=body.sender_id,
        sender_name=body.sender_name,
    )

    return IngestResponse(
        job_id=job_id,
        url=clean_url,
        shortcode=shortcode,
        status="queued",
    )


@app.get("/jobs/{job_id}")
def read_job(job_id: int) -> dict:
    """查一個 job 的進度。"""

    job = db_writer.get_job(job_id)

    if job is None:
        raise HTTPException(
            status_code=404,
            detail="job not found",
        )

    for key in ("created_at", "updated_at"):
        if job.get(key) is not None:
            job[key] = job[key].isoformat()

    return job
