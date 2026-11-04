# Evolution API v2.3.7 con los parches de evolution/parcheEvolution.js ya aplicados.
# La base va fijada por digest: si alguien vuelve a publicar el tag, no cambia lo que corre.
FROM evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339

COPY parcheEvolution.js /parches/parcheEvolution.js
# Si un parche no encaja, el build falla: nunca queda una imagen sin parchear.
RUN node /parches/parcheEvolution.js

# Al arrancar se vuelve a verificar (sin escribir) y recién después arranca Evolution.
ENTRYPOINT ["/bin/bash", "-c", "node /parches/parcheEvolution.js --verificar && . ./Docker/scripts/deploy_database.sh && npm run start:prod"]
