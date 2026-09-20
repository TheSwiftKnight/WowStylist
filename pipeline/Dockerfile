# WowStylist 分析 pipeline —— Railway / 任何 container host 都能跑
#
# Railway 設定：Service → Settings → Root Directory 填 `pipeline`，
# 它就會用這支 Dockerfile。

FROM python:3.12-slim

# opencv 讀 Reel 的 mp4 要這些。
# 用的是 opencv-python-headless，所以不需要整套 GUI 的 libGL。
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先裝相依，這層才能被 cache 住（改程式碼不用重裝）
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY . .

# 容器的檔案系統是暫時的，暫存檔丟 /tmp 就好
ENV PIPELINE_OUTPUT_DIR=/tmp/wowstylist-outputs
ENV PYTHONUNBUFFERED=1

# Railway 會給 $PORT，本機沒有的話用 8000
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
