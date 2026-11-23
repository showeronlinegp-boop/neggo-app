# Vigía de WhatsApp (nota 247): mira el log del Evolution del negocio y lo frena si se desmadra.
# Construir:  docker build -t neggo-vigia-whatsapp:1 tools/vigia-whatsapp
# Correr (fuera del compose, como neggo-evolution-negocio):
#   docker run -d --name neggo-vigia-whatsapp --restart unless-stopped \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v "C:/Users/Mariano Menendez/neggo-whatsapp-negocio/vigia:/vigia" \
#     -e VIGIA_DIR_HOST="C:\Users\Mariano Menendez\neggo-whatsapp-negocio\vigia" \
#     neggo-vigia-whatsapp:1
FROM node:20-alpine
WORKDIR /app
COPY reglasVigia.js vigiaWhatsapp.js reglasVigia.test.js ./
RUN node reglasVigia.test.js
CMD ["node", "vigiaWhatsapp.js"]
