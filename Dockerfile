# Serves the static site in dist/ with the dependency-free Node server in scripts/.
FROM node:22-alpine
WORKDIR /app
COPY scripts/serve.mjs scripts/serve.mjs
COPY dist dist
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER node
CMD ["node", "scripts/serve.mjs"]
