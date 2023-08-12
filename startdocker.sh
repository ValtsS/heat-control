#!/bin/sh
docker stop heat-control
docker container rm heat-control
docker run --name heat-control --restart unless-stopped --env-file ./.env -p 8005:8005 -d valtss/heat-control
