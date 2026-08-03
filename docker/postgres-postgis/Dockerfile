# PostgreSQL 17 + PostGIS 3.5 for local development and integration tests.
#
# Upstream equivalent (when Docker Hub is reachable):
#   postgis/postgis:17-3.5
#
# Official postgres Alpine images install under /usr/local, while Alpine's
# `postgis` package targets distro PostgreSQL paths. After installing the
# package we link the PostGIS 3.5 artifacts into the image's pg paths.
FROM postgres:17.6-alpine

RUN apk add --no-cache 'postgis=~3.5' \
  && ln -sf /usr/lib/postgresql17/postgis*.so /usr/local/lib/postgresql/ \
  && ln -sf /usr/lib/postgresql17/address_standardizer*.so /usr/local/lib/postgresql/ \
  && ln -sf /usr/share/postgresql17/extension/postgis* /usr/local/share/postgresql/extension/ \
  && ln -sf /usr/share/postgresql17/extension/address_standardizer* /usr/local/share/postgresql/extension/
