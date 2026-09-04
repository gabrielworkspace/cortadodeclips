# -*- coding: utf-8 -*-
"""
Transcreve um audio com faster-whisper e grava um JSON com timestamps por palavra.
Reporta progresso em stdout, uma linha JSON por vez, para o Node acompanhar.
"""
import argparse
import io
import json
import os
import sys

# Windows costuma abrir o stdout em cp1252 e quebrar com acento.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def avisar(tipo, **campos):
    campos["tipo"] = tipo
    print(json.dumps(campos, ensure_ascii=False), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--audio", required=True)
    p.add_argument("--saida", required=True)
    p.add_argument("--modelo", default="small")
    p.add_argument("--idioma", default="pt")
    p.add_argument("--duracao", type=float, default=0.0)
    args = p.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        avisar("erro", msg="faster-whisper nao instalado. Rode instalar.bat de novo.")
        sys.exit(2)

    avisar("progresso", pct=2, msg="Carregando o modelo de transcricao (%s)..." % args.modelo)

    # Em container, os.cpu_count() ve os nucleos do HOST, nao a cota da
    # maquina (cgroup) - pedir threads demais deixa mais lento, nao mais
    # rapido. NUM_THREADS deixa o dono do servidor fixar o numero certo.
    threads_do_ambiente = os.environ.get("NUM_THREADS")
    if threads_do_ambiente:
        threads = max(1, int(threads_do_ambiente))
    else:
        threads = max(1, (os.cpu_count() or 4) - 2)

    # MODELOS_DIR aponta pro modelo ja assado na imagem do container (o
    # Dockerfile baixa na build). Sem isso, cada job baixaria ~500 MB de
    # novo do HuggingFace numa pasta que some a cada deploy.
    pasta_modelos = os.environ.get("MODELOS_DIR") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "modelos"
    )

    # int8 no CPU: bem mais rapido e cabe folgado na RAM.
    modelo = WhisperModel(
        args.modelo,
        device="cpu",
        compute_type="int8",
        cpu_threads=threads,
        download_root=pasta_modelos,
    )

    avisar("progresso", pct=6, msg="Ouvindo o video inteiro...")

    segmentos_iter, info = modelo.transcribe(
        args.audio,
        language=(None if args.idioma == "auto" else args.idioma),
        task="transcribe",
        beam_size=1,                           # greedy: ~2x mais rapido no CPU e quase a mesma qualidade
        best_of=1,
        temperature=0.0,
        vad_filter=True,                       # corta silencio, acelera e evita alucinacao
        vad_parameters={"min_silence_duration_ms": 400},
        word_timestamps=True,                  # precisamos disso pro corte e pra legenda
        condition_on_previous_text=False,      # evita o modelo repetir frase em loop
    )

    duracao = args.duracao or float(getattr(info, "duration", 0) or 0)
    idioma = getattr(info, "language", args.idioma)

    segmentos = []
    ultimo_aviso = 0.0
    for s in segmentos_iter:
        palavras = []
        for w in (s.words or []):
            texto = (w.word or "").strip()
            if not texto:
                continue
            palavras.append({
                "inicio": round(float(w.start), 3),
                "fim": round(float(w.end), 3),
                "texto": texto,
                "conf": round(float(getattr(w, "probability", 0.0) or 0.0), 3),
            })

        segmentos.append({
            "inicio": round(float(s.start), 3),
            "fim": round(float(s.end), 3),
            "texto": (s.text or "").strip(),
            "palavras": palavras,
        })

        # 6% -> 92% conforme caminha na linha do tempo do video
        if duracao > 0 and (s.end - ultimo_aviso) > 3:
            ultimo_aviso = s.end
            pct = 6 + min(86.0, (s.end / duracao) * 86.0)
            avisar("progresso", pct=round(pct, 1),
                   msg="Transcrevendo... %s de %s" % (mmss(s.end), mmss(duracao)))

    total_palavras = sum(len(s["palavras"]) for s in segmentos)
    if total_palavras == 0:
        avisar("erro", msg="Nao encontrei fala nenhuma no audio desse video.")
        sys.exit(3)

    with open(args.saida, "w", encoding="utf-8") as f:
        json.dump({
            "idioma": idioma,
            "duracao": duracao,
            "segmentos": segmentos,
        }, f, ensure_ascii=False)

    avisar("progresso", pct=94, msg="Transcricao pronta: %d palavras." % total_palavras)
    avisar("ok", palavras=total_palavras, segmentos=len(segmentos))


def mmss(s):
    s = int(s or 0)
    return "%d:%02d" % (s // 60, s % 60)


if __name__ == "__main__":
    main()
