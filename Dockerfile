ARG MATTERBRIDGE_BASE_IMAGE=luligu/matterbridge:3.11.2
FROM ${MATTERBRIDGE_BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json index.js player.js profiles.js /usr/local/lib/node_modules/matterbridge-audio-poc/
COPY apps/frontend/build/ /usr/local/lib/node_modules/matterbridge-audio-poc/apps/frontend/build/
COPY docker-start.sh /usr/local/bin/matterbridge-audio-poc-start
CMD ["/bin/sh", "/usr/local/bin/matterbridge-audio-poc-start"]
