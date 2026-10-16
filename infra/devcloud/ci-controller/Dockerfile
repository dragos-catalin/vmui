FROM node:24.21.0-alpine3.24
WORKDIR /app
COPY server.mjs runner-startup.sh runner-startup.ps1 ./
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
