FROM node:24-alpine

RUN apk add --no-cache git python3 py3-pip py3-virtualenv

WORKDIR /opt/nocode-session
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY session-server.mjs ./

USER root
WORKDIR /workspace

ENV NOCODE_SESSION_PORT=3000
EXPOSE 3000
CMD ["node", "/opt/nocode-session/session-server.mjs"]