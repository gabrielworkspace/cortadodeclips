# syntax=docker/dockerfile:1
# =============================================================================
#  Cortador Automatico - imagem de producao (Linux)
#  Node 22 + ffmpeg (libx264/libass) + Python 3.11 + faster-whisper + yt-dlp
#  Base: Debian 12 bookworm slim
#
#  Build:  docker build -t cortador .
#  Rodar:  docker run -p 8080:8080 -v cortador-dados:/dados -e AUTH_SENHA=troque-isso cortador
#  Abrir:  http://localhost:8080
#
#  Pra trocar o modelo de transcricao (padrao "small", ~464 MB):
#  docker build --build-arg MODELO_WHISPER=medium -t cortador .
# =============================================================================
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    NODE_ENV=production

# -----------------------------------------------------------------------------
# 1) Binarios de sistema
#    - ffmpeg do Debian ja vem com libx264 (usado em src/media.js) e libass
#      (o filtro "subtitles=" que queima a legenda .ass gerada em src/legenda.js).
#    - gosu: o volume da nuvem monta como root; o entrypoint conserta o dono
#      da pasta de dados e so entao larga o privilegio.
#    - tini: processo init de verdade, encaminha sinais (Ctrl+C, docker stop)
#      pro Node direito, em vez de matar o container na marra.
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-venv \
        fontconfig \
        fonts-dejavu-core \
        fonts-liberation \
        ca-certificates \
        gosu \
        tini \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# 2) Fontes da legenda
#    src/legenda.js pede a fonte "Arial Black", que nao existe no Linux. Sem
#    este alias o libass cai numa fonte generica e a legenda sai fina, bem
#    diferente do que aparece no Windows. O estilo ja manda Bold=-1, entao
#    DejaVu Sans (que tem peso Bold de verdade) fica bem parecido.
# -----------------------------------------------------------------------------
RUN mkdir -p /etc/fonts && printf '%s\n' \
'<?xml version="1.0"?>' \
'<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">' \
'<fontconfig>' \
'  <match target="pattern">' \
'    <test name="family"><string>Arial Black</string></test>' \
'    <edit name="family" mode="assign" binding="same"><string>DejaVu Sans</string></edit>' \
'  </match>' \
'  <match target="pattern">' \
'    <test name="family"><string>Arial</string></test>' \
'    <edit name="family" mode="assign" binding="same"><string>Liberation Sans</string></edit>' \
'  </match>' \
'</fontconfig>' > /etc/fonts/local.conf \
    && fc-cache -f

# -----------------------------------------------------------------------------
# 3) Python num venv proprio
#    Debian 12 bloqueia "pip install" direto no Python do sistema (PEP 668).
#    faster-whisper puxa ctranslate2 (biblioteca C++ nativa) e onnxruntime
#    (usado pelo vad_filter=True do transcrever.py). Nao instalamos torch -
#    faster-whisper nao precisa dele.
#    yt-dlp com o extra curl-cffi, pra "--impersonate chrome/edge" (src/baixar.js)
#    realmente funcionar contra Kick/Twitch, que ficam atras de Cloudflare.
# -----------------------------------------------------------------------------
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir "faster-whisper>=1.1,<2" \
    && pip install --no-cache-dir "yt-dlp[default,curl-cffi]"

# -----------------------------------------------------------------------------
# 4) Modelo de transcricao ASSADO na imagem
#    Sem isso, o primeiro job de cada container novo gastaria minutos baixando
#    ~500 MB do HuggingFace - e como o disco do container e substituido a cada
#    deploy, isso aconteceria de novo toda vez.
# -----------------------------------------------------------------------------
ARG MODELO_WHISPER=small
ENV MODELOS_DIR=/opt/modelos \
    HF_HOME=/opt/hf
RUN mkdir -p "$MODELOS_DIR" "$HF_HOME" \
    && python3 -c "from faster_whisper import WhisperModel; WhisperModel('${MODELO_WHISPER}', device='cpu', compute_type='int8', download_root='${MODELOS_DIR}')" \
    && chmod -R a+rX "$MODELOS_DIR" "$HF_HOME"

# -----------------------------------------------------------------------------
# 5) Aplicacao Node
# -----------------------------------------------------------------------------
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY py ./py

# -----------------------------------------------------------------------------
# 6) Entrypoint: prepara /dados e larga o root
#    O volume da nuvem chega vazio e dono de root. Sem isso o processo (que
#    roda como usuario "node") nao consegue escrever nada em /dados.
# -----------------------------------------------------------------------------
RUN printf '%s\n' \
'#!/bin/sh' \
'set -e' \
': "${DADOS:=/dados}"' \
'mkdir -p "$DADOS/trabalho" "$DADOS/saida" "$DADOS/baixados"' \
'chown -R node:node "$DADOS" 2>/dev/null || true' \
'if [ "$(id -u)" = "0" ]; then exec gosu node "$@"; else exec "$@"; fi' \
> /usr/local/bin/entrada.sh \
    && chmod +x /usr/local/bin/entrada.sh \
    && mkdir -p /dados && chown -R node:node /dados /app

# -----------------------------------------------------------------------------
# 7) Ambiente
#    NUM_THREADS fixo de proposito: dentro de container, os.cpus() (Node) e
#    os.cpu_count() (Python) enxergam os nucleos do HOST, nao a cota da sua
#    maquina - pedir threads demais deixa a transcricao MAIS LENTA, nao mais
#    rapida. Ajuste ao numero real de vCPU contratado.
# -----------------------------------------------------------------------------
ENV DADOS=/dados \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    YTDLP_PATH=/opt/venv/bin/yt-dlp \
    PYTHON_BIN=/opt/venv/bin/python3 \
    NAO_ABRIR=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    NUM_THREADS=2 \
    QUALIDADE_PADRAO=alta

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok||r.status===200?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrada.sh"]
CMD ["node", "src/server.js"]
