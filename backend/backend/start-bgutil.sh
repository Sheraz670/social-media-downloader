#!/bin/bash

set -e

cd /opt/render/project/src/backend/backend

if [ ! -d "bgutil-ytdlp-pot-provider" ]; then
  git clone --single-branch --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
fi

cd bgutil-ytdlp-pot-provider/server

npm ci
npx tsc

node build/main.js --host 127.0.0.1 --port 4416 &
