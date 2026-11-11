FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TT_DB=/data/tracker.db TT_PORT=8080

# No Python packages needed: the app uses only the standard library. tzdata makes TZ work.
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /app tracker \
 && mkdir -p /data && chown tracker /data
WORKDIR /app
COPY --chown=tracker app/ /app/
COPY --chown=tracker README.md /app/README.md

USER tracker
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/api/me' % os.environ.get('TT_PORT','8080'),timeout=4)" || exit 1
CMD ["python", "server.py", "serve"]
