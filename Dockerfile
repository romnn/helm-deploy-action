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
  org.label-schema.vendor="romnn" \
  org.label-schema.schema-version="1.0"

# unfortunately, cannot upgrade helm and the push plugin due to conflicts
ENV HELM_VERSION v3.14.4
ENV HELM_PLUGIN_PUSH_VERSION v0.10.4

RUN mkdir -p /action-data/helm
ENV XDG_DATA_HOME=/action-data/helm
ENV XDG_CACHE_HOME=/action-data/helm
ENV XDG_CONFIG_HOME=/action-data/helm
ENV DEPLOY_ACTION_DATA_HOME=/action-data

RUN apk add curl jq nodejs tar bash --no-cache
RUN set -ex \
    && curl -sSL https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz | tar xz \
    && mv linux-amd64/helm /usr/local/bin/helm \
    && rm -rf linux-amd64 

RUN apk add --virtual .helm-build-deps git make \
    && helm plugin install https://github.com/chartmuseum/helm-push.git --version ${HELM_PLUGIN_PUSH_VERSION} \
    && apk del --purge .helm-build-deps

# RUN chmod -R 777 /action-data && chown -R nobody /action-data
# RUN addgroup -S actions-group && adduser -S actions-user -G actions-group
# USER actions-user
# USER nobody

WORKDIR /action-data
COPY --from=DEPS /action/dist /action/dist
ENTRYPOINT ["node", "/action/dist/index.js"]
