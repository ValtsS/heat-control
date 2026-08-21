#!/bin/sh
docker stop heat-control
docker container rm heat-control
# named volume persists the SQLite DB (./data/heat.db) across restarts/rebuilds
# swap to a bind mount if you want the file on the host: -v "$PWD/data:/usr/src/app/data"
docker run --name heat-control --restart unless-stopped --env-file ./.env \
  -p 8005:8005 \
  -v heat-control-data:/usr/src/app/data \
  -d valtss/heat-control
