FROM node:latest as DEPS

WORKDIR /action

COPY package*.json /action/
COPY tsconfig.json /action/
COPY src /action/src

RUN npm install
RUN npm run build
RUN npm run package

FROM alpine:latest

LABEL maintainer="romnn <contact@romnn.com>" \
  org.label-schema.name="helm deploy action" \
  org.label-schema.vendor="romnnn" \
  org.label-schema.schema-version="1.0"

ENV HELM_VERSION v3.4.2

ENV XDG_DATA_HOME=/opt/xdg
ENV XDG_CACHE_HOME=/opt/xdg
ENV XDG_CONFIG_HOME=/opt/xdg

RUN apk add curl jq nodejs tar bash --no-cache
RUN set -ex \
    && curl -sSL https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz | tar xz \
    && mv linux-amd64/helm /usr/local/bin/helm \
    && rm -rf linux-amd64 

WORKDIR /action
COPY --from=DEPS /action/dist /action/dist
ENTRYPOINT ["node", "/action/dist/index.js"]
