# Verified multi-arch v0.7.62.11; AKS builds select linux/amd64.
FROM wiktorn/overpass-api@sha256:5f643f2aa500333f19458fe8be14457215d6e0b9f891ca5c5ed452b1f8882c47
USER root
RUN mkdir -p /opt/regional /db && chown 1000:1000 /db \
    && test -x /app/bin/update_database && test -x /app/bin/osm3s_query \
    && command -v osmium && command -v python3
COPY bootstrap.py server.py profiles.py selftest.py /opt/regional/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /db
USER 1000:1000
RUN python3 /opt/regional/selftest.py
# The upstream nginx/supervisor/init scripts require root and are not used.
ENTRYPOINT ["python3"]
CMD ["/opt/regional/server.py"]
HEALTHCHECK NONE
EXPOSE 8080
