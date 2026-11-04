# Evolution 2.3.7 parcheado: no reenvía mensajes vacíos al reconectar.
# Bug upstream: https://github.com/evolution-foundation/evolution-api/issues/2705
# getMessage devolvía { conversation: '' } cuando no encontraba el mensaje;
# Baileys lo tomaba como contenido real y lo reenviaba en ráfaga a los grupos.

FROM evoapicloud/evolution-api:v2.3.7

USER root
COPY patch-empty-retry.sh /tmp/patch-empty-retry.sh
RUN chmod +x /tmp/patch-empty-retry.sh && /tmp/patch-empty-retry.sh
