#!/bin/bash
# Reemplaza el return vacío de getMessage por undefined.
# Si no encuentra el patrón, falla el build: así no publicamos una imagen sin el parche.
set -euo pipefail

ROOT="${EVOLUTION_ROOT:-/evolution}"
if [ ! -d "$ROOT" ]; then
  echo "ERROR: no está $ROOT (¿cambió el layout de la imagen?)" >&2
  exit 1
fi

mapfile -t files < <(grep -rl --include='*.js' --include='*.mjs' --include='*.cjs' \
  -e "conversation: ''" -e 'conversation: ""' -e "conversation:''" -e 'conversation:""' \
  "$ROOT/dist" "$ROOT" 2>/dev/null | sort -u || true)

if [ "${#files[@]}" -eq 0 ]; then
  echo "ERROR: no encontré el patrón conversation: '' en $ROOT" >&2
  echo "La imagen puede haber cambiado; hay que actualizar este parche." >&2
  exit 1
fi

patched=0
for f in "${files[@]}"; do
  before=$(grep -c -E "return \{ conversation: '' \}|return \{ conversation: \"\" \}|return\{conversation:''\}|return\{conversation:\"\"\}" "$f" || true)
  if [ "$before" -eq 0 ]; then
    continue
  fi
  sed -i \
    -e "s/return { conversation: '' }/return undefined/g" \
    -e "s/return { conversation: \"\" }/return undefined/g" \
    -e "s/return{conversation:''}/return undefined/g" \
    -e 's/return{conversation:""}/return undefined/g' \
    "$f"
  after=$(grep -c -E "return \{ conversation: '' \}|return \{ conversation: \"\" \}|return\{conversation:''\}|return\{conversation:\"\"\}" "$f" || true)
  if [ "$after" -ne 0 ]; then
    echo "ERROR: quedó el patrón vacío en $f" >&2
    exit 1
  fi
  echo "patched $f ($before ocurrencias)"
  patched=$((patched + before))
done

if [ "$patched" -eq 0 ]; then
  echo "ERROR: encontré 'conversation' vacío pero no el return de getMessage" >&2
  exit 1
fi

echo "OK: parche anti-vacío aplicado ($patched return(s))"
