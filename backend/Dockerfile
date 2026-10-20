FROM node:20-alpine

WORKDIR /app

# Dependencias del sistema: build tools + Python + Chromium headless
RUN apk add --no-cache \
    python3 \
    py3-pip \
    make g++ vips-dev \
    chromium \
    chromium-chromedriver

# Virtual environment Python para los scrapers
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

# Instalar dependencias Python de los scrapers
RUN pip install --no-cache-dir selenium==4.18.1 beautifulsoup4

# Dependencias Node
COPY package.json ./
RUN npm install --omit=dev

# CACHEBUST cambia el layer de código sin rehacer npm install
ARG CACHEBUST=202610201345
RUN echo "cachebust=$CACHEBUST"
COPY . .

RUN mkdir -p /app/storage/catalogs /app/storage/photos/odoo

EXPOSE 3000
CMD ["node", "server.js"]
