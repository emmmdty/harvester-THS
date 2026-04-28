FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV HOST=0.0.0.0
ENV HEADLESS=1
ENV DOCKER=1

EXPOSE 3000

CMD ["npm", "run", "ui"]
