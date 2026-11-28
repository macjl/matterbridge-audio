ARG MATTERBRIDGE_BASE_IMAGE=luligu/matterbridge:3.11.5
FROM ${MATTERBRIDGE_BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg alsa-utils && rm -rf /var/lib/apt/lists/*
COPY package.json index.js player.js profiles.js mixer.js /usr/local/lib/node_modules/matterbridge-securitysystem-audio/
COPY apps/frontend/build/ /usr/local/lib/node_modules/matterbridge-securitysystem-audio/apps/frontend/build/
COPY docker-start.sh /usr/local/bin/matterbridge-securitysystem-audio-start
CMD ["/bin/sh", "/usr/local/bin/matterbridge-securitysystem-audio-start"]
