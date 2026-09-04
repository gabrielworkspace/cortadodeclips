'use strict';
/** Tudo que fala com ffmpeg: inspecionar, extrair audio, medir energia e cortar. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// No Windows o winget instala o ffmpeg mas o PATH so vale em processo novo,
// entao procuramos nos lugares conhecidos do WinGet. No Linux/container o
// Dockerfile ja deixa o binario certo numa variavel de ambiente ou no PATH.
function acharBinario(nome) {
  const doAmbiente = process.env[nome.toUpperCase() + '_PATH'];
  if (doAmbiente) return [doAmbiente];

  if (process.platform !== 'win32') {
    return [nome, '/usr/bin/' + nome, '/usr/local/bin/' + nome];
  }

  const candidatos = [nome + '.exe'];
  const base = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!/ffmpeg/i.test(dir)) continue;
      const raiz = path.join(base, dir);
      for (const sub of fs.readdirSync(raiz)) {
        const alvo = path.join(raiz, sub, 'bin', nome + '.exe');
        if (fs.existsSync(alvo)) candidatos.push(alvo);
      }
    }
  } catch (_) { /* pasta do winget pode nao existir */ }
  candidatos.push(path.join('C:', 'ffmpeg', 'bin', nome + '.exe'));
  return candidatos;
}

let FFMPEG = null;
let FFPROBE = null;

function testar(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, ['-version'], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

async function garantirFfmpeg() {
  if (FFMPEG && FFPROBE) return { ffmpeg: FFMPEG, ffprobe: FFPROBE };
  for (const c of acharBinario('ffmpeg')) {
    if (await testar(c)) { FFMPEG = c; break; }
  }
  for (const c of acharBinario('ffprobe')) {
    if (await testar(c)) { FFPROBE = c; break; }
  }
  if (!FFMPEG || !FFPROBE) {
    throw new Error('Nao encontrei o ffmpeg. Rode o instalar.bat.');
  }
  return { ffmpeg: FFMPEG, ffprobe: FFPROBE };
}

function rodar(cmd, args, opcoes) {
  opcoes = opcoes || {};
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd: opcoes.cwd });
    let saida = '';
    let erro = '';

    p.stdout.on('data', (d) => {
      const t = d.toString();
      saida += t;
      if (opcoes.aoProgredir) {
        for (const linha of t.split(/\r?\n/)) {
          const m = /^out_time_ms=(\d+)/.exec(linha);
          if (m) opcoes.aoProgredir(Number(m[1]) / 1e6);
        }
      }
    });
    p.stderr.on('data', (d) => { erro += d.toString(); if (erro.length > 60000) erro = erro.slice(-40000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(saida);
      else reject(new Error('ffmpeg falhou (codigo ' + code + '):\n' + erro.split(/\r?\n/).slice(-12).join('\n')));
    });
  });
}

/** Duracao, resolucao e se tem audio. */
async function inspecionar(video) {
  const { ffprobe } = await garantirFfmpeg();
  const saida = await rodar(ffprobe, [
    '-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', video,
  ]);
  const info = JSON.parse(saida);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  return {
    duracao: Number((info.format || {}).duration || 0),
    largura: v ? v.width : 0,
    altura: v ? v.height : 0,
    temAudio: !!a,
    temVideo: !!v,
    fps: v && v.r_frame_rate ? eval2(v.r_frame_rate) : 30,
  };
}

function eval2(fracao) {
  const p = String(fracao).split('/');
  const n = Number(p[0]);
  const d = Number(p[1] || 1);
  return d ? Math.round((n / d) * 100) / 100 : 30;
}

/** Extrai audio 16kHz mono - formato que o Whisper quer e que da pra medir energia. */
async function extrairAudio(video, destino, duracao, aoProgredir) {
  const { ffmpeg } = await garantirFfmpeg();
  await rodar(ffmpeg, [
    '-y', '-i', video,
    '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '-progress', 'pipe:1', '-nostats',
    '-loglevel', 'error',
    destino,
  ], {
    aoProgredir: (seg) => {
      if (aoProgredir && duracao > 0) aoProgredir(Math.min(1, seg / duracao));
    },
  });
  return destino;
}

/**
 * RMS por segundo do WAV, normalizado de 0 a 1 pelo percentil 95.
 * Le direto do arquivo - e PCM 16 bits mono, entao e so somar quadrados.
 */
function energiaPorSegundo(wav) {
  const buf = fs.readFileSync(wav);
  const inicioDados = acharChunkData(buf);
  const amostrasPorSeg = 16000;
  const bytesPorSeg = amostrasPorSeg * 2;
  const totalSeg = Math.floor((buf.length - inicioDados) / bytesPorSeg);
  const bruto = new Array(totalSeg);

  for (let s = 0; s < totalSeg; s++) {
    let soma = 0;
    const base = inicioDados + s * bytesPorSeg;
    // Amostra 1 a cada 8 - suficiente pra energia e 8x mais rapido
    let n = 0;
    for (let i = 0; i < amostrasPorSeg; i += 8) {
      const v = buf.readInt16LE(base + i * 2) / 32768;
      soma += v * v;
      n++;
    }
    bruto[s] = Math.sqrt(soma / Math.max(1, n));
  }

  const ordenado = bruto.slice().sort((a, b) => a - b);
  const p95 = ordenado[Math.floor(ordenado.length * 0.95)] || 1;
  return bruto.map((v) => Math.min(1, v / (p95 || 1)));
}

function acharChunkData(buf) {
  // Pula o header RIFF ate o chunk "data"
  let pos = 12;
  while (pos + 8 < buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const tam = buf.readUInt32LE(pos + 4);
    if (id === 'data') return pos + 8;
    pos += 8 + tam + (tam % 2);
  }
  return 44;
}

const LARGURA = 1080;
const ALTURA = 1920;

/** Garante numero par - o libx264 com yuv420p exige dimensao par. */
function par(n) {
  n = Math.round(n);
  return n % 2 ? n + 1 : n;
}

/**
 * Perfis de compressao. Recodificar sempre e lossy, mas de crf 15 pra baixo a
 * diferenca some no olho - e o TikTok/Reels recomprime tudo de novo mesmo.
 */
const QUALIDADES = {
  maxima:  { crf: '15', preset: 'slow',     audio: '256k' },
  alta:    { crf: '18', preset: 'medium',   audio: '192k' },
  rapida:  { crf: '23', preset: 'veryfast', audio: '128k' },
};

function perfilDeQualidade(nome) {
  // Num servidor com CPU compartilhada, 'maxima' (crf 15 + preset slow) pode
  // levar uma hora so de encode em 8 clipes. QUALIDADE_PADRAO deixa o dono do
  // servidor baixar a fasquia sem mudar cada rodada.
  const padrao = QUALIDADES[process.env.QUALIDADE_PADRAO] ? process.env.QUALIDADE_PADRAO : 'maxima';
  return QUALIDADES[nome] || QUALIDADES[padrao];
}

/** #RRGGBB do seletor de cor vira 0xRRGGBB, que e o formato que o ffmpeg entende. */
function corParaFfmpeg(cor) {
  const limpa = String(cor || '#ffffff').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(limpa) ? '0x' + limpa : '0xffffff';
}

/** Monta o pedaco de filtro que recorta uma regiao (em fracao do frame) e a encaixa num tamanho fixo. */
function recorteEncaixado(entrada, area, largura, altura, saida) {
  const a = area || { x: 0, y: 0, w: 1, h: 1 };
  const cx = Math.max(0, Math.min(0.999, a.x));
  const cy = Math.max(0, Math.min(0.999, a.y));
  const cw = Math.max(0.02, Math.min(1 - cx, a.w));
  const ch = Math.max(0.02, Math.min(1 - cy, a.h));

  return '[' + entrada + ']crop=' +
    'iw*' + cw.toFixed(5) + ':ih*' + ch.toFixed(5) + ':' +
    'iw*' + cx.toFixed(5) + ':ih*' + cy.toFixed(5) + ',' +
    'scale=' + largura + ':' + altura + ':force_original_aspect_ratio=increase:flags=lanczos,' +
    'crop=' + largura + ':' + altura + ',setsar=1[' + saida + ']';
}

/**
 * Filtro de video conforme o formato escolhido.
 * @param {string} formato  original | vertical | blur | split
 * @param {object} recorte  usado no split: { topo, baixo, proporcaoTopo }
 */
function filtroDeFormato(formato, recorte) {
  if (formato === 'original') return null;

  // Foco: usa so a area que a pessoa marcou (o jogo, em geral) e enquadra
  // ela em 9:16. Serve pro video que nao tem webcam separada.
  if (formato === 'foco') {
    const r = recorte || {};
    return recorteEncaixado('0:v', r.baixo, LARGURA, ALTURA, 'v');
  }

  if (formato === 'split') {
    // Estilo corte de streamer: a webcam em cima, o gameplay embaixo.
    const r = recorte || {};
    const fracao = Math.max(0.15, Math.min(0.6, r.proporcaoTopo || 0.3));
    const alturaTopo = par(ALTURA * fracao);
    const alturaBaixo = ALTURA - alturaTopo;

    // Linha na junção das duas partes - separa o rosto do gameplay.
    const linha = r.linha || {};
    const espessura = Math.max(0, Math.min(40, Number(linha.espessura) || 0));
    let divisoria = '';
    if (espessura > 0) {
      const cor = corParaFfmpeg(linha.cor);
      const y = Math.max(0, alturaTopo - Math.floor(espessura / 2));
      divisoria = ',drawbox=x=0:y=' + y + ':w=' + LARGURA + ':h=' + espessura +
                  ':color=' + cor + ':t=fill';
    }

    return [
      recorteEncaixado('0:v', r.topo, LARGURA, alturaTopo, 'topo'),
      recorteEncaixado('0:v', r.baixo, LARGURA, alturaBaixo, 'baixo'),
      '[topo][baixo]vstack=inputs=2,setsar=1' + divisoria + '[v]',
    ].join(';');
  }

  if (formato === 'blur') {
    // Video inteiro no centro, fundo borrado preenchendo o 9:16
    return '[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,' +
           'gblur=sigma=28,eq=brightness=-0.06[bg];' +
           '[0:v]scale=1080:-2:force_original_aspect_ratio=decrease:flags=lanczos[fg];' +
           '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]';
  }

  // vertical: preenche a tela cortando as laterais
  return '[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1[v]';
}

/**
 * Corta um clipe.
 * @param {object} o { video, inicio, duracao, destino, formato, arquivoAss, pastaTrabalho, aoProgredir }
 */
async function cortarClipe(o) {
  const { ffmpeg } = await garantirFfmpeg();

  // Sem reenquadrar e sem legenda nao ha nada pra desenhar: copiamos o fluxo
  // original bit a bit. Zero recodificacao, zero perda, e sai em segundos.
  if (o.formato === 'original' && !o.arquivoAss) {
    await rodar(ffmpeg, [
      '-y', '-ss', String(o.inicio), '-i', o.video, '-t', String(o.duracao),
      '-c', 'copy', '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
      o.destino,
    ], {
      aoProgredir: (seg) => { if (o.aoProgredir) o.aoProgredir(Math.min(1, seg / o.duracao)); },
    });
    return o.destino;
  }

  const args = [
    '-y',
    '-ss', String(o.inicio),          // seek antes do input: rapido
    '-i', o.video,
    '-t', String(o.duracao),
  ];

  const filtroBase = filtroDeFormato(o.formato, o.recorte);
  // A legenda entra depois do enquadramento, ja no tamanho final.
  // Rodamos o ffmpeg com cwd na pasta do .ass e passamos so o nome:
  // isso evita todo o inferno de escapar caminho do Windows no filtro.
  const legenda = o.arquivoAss ? "subtitles=" + o.arquivoAss : null;

  if (filtroBase) {
    const complexo = legenda
      ? filtroBase.replace(/\[v\]$/, '[vf];[vf]' + legenda + '[v]')
      : filtroBase;
    args.push('-filter_complex', complexo, '-map', '[v]', '-map', '0:a?');
  } else if (legenda) {
    args.push('-vf', legenda);
  }

  const q = perfilDeQualidade(o.qualidade);

  args.push(
    '-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-level', '4.2',
    '-x264-params', 'ref=4:bframes=3:aq-mode=3',  // ajuda em gameplay, que tem muito movimento
    '-c:a', 'aac', '-b:a', q.audio, '-ar', '48000',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
    o.destino,
  );

  await rodar(ffmpeg, args, {
    cwd: o.pastaTrabalho,
    aoProgredir: (seg) => {
      if (o.aoProgredir) o.aoProgredir(Math.min(1, seg / o.duracao));
    },
  });
  return o.destino;
}

/** Uma imagem do meio do clipe, pra mostrar na tela. */
async function gerarMiniatura(video, segundo, destino, vertical) {
  const { ffmpeg } = await garantirFfmpeg();
  const vf = vertical
    ? 'scale=360:640:force_original_aspect_ratio=increase,crop=360:640'
    : 'scale=360:-2';
  try {
    await rodar(ffmpeg, [
      '-y', '-ss', String(segundo), '-i', video,
      '-frames:v', '1', '-vf', vf, '-q:v', '4',
      '-loglevel', 'error', destino,
    ]);
    return destino;
  } catch (_) {
    return null; // miniatura e enfeite, nao vale derrubar o processo
  }
}

/** Igual ao rodar(), mas junta a saida como bytes - pra ler frame cru. */
function rodarBinario(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const pedacos = [];
    let erro = '';
    p.stdout.on('data', (d) => pedacos.push(d));
    p.stderr.on('data', (d) => { erro += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(pedacos));
      else reject(new Error('ffmpeg falhou: ' + erro.split(/\r?\n/).slice(-6).join('\n')));
    });
  });
}

const AMOSTRA_L = 320;
const AMOSTRA_A = 180;

/** Um frame pequeno em RGB cru, pra analisar pixel a pixel sem depender de biblioteca. */
async function amostrarFrame(video, segundo) {
  const { ffmpeg } = await garantirFfmpeg();
  const buf = await rodarBinario(ffmpeg, [
    '-ss', String(Math.max(0, segundo)), '-i', video,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', AMOSTRA_L + 'x' + AMOSTRA_A, '-loglevel', 'error', 'pipe:1',
  ]);
  return buf.length >= AMOSTRA_L * AMOSTRA_A * 3 ? buf : null;
}

function pixel(buf, x, y) {
  const i = (y * AMOSTRA_L + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
}

function diferencaEntreLinhas(buf, eixo, pos, de, ate, salto) {
  let soma = 0, n = 0;
  for (let t = de; t <= ate; t++) {
    let a, b;
    if (eixo === 'x') {           // borda vertical: compara colunas
      if (pos - salto < 0 || pos + salto >= AMOSTRA_L) return null;
      a = pixel(buf, pos - salto, t); b = pixel(buf, pos + salto, t);
    } else {                       // borda horizontal: compara linhas
      if (pos - salto < 0 || pos + salto >= AMOSTRA_A) return null;
      a = pixel(buf, t, pos - salto); b = pixel(buf, t, pos + salto);
    }
    soma += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
    n++;
  }
  return n ? soma / n : null;
}

/**
 * A webcam sobreposta cria uma quebra brusca de imagem na moldura dela.
 * Se a gente compara os pixels de dentro com os de fora da borda e a diferenca
 * e MUITO maior que a variacao normal da imagem, tem uma janela ali.
 * Quando o streamer poe a cara em tela cheia, essa quebra some.
 */
function medirBordaDaWebcam(buf, area) {
  const x0 = Math.round(area.x * AMOSTRA_L);
  const y0 = Math.round(area.y * AMOSTRA_A);
  const x1 = Math.round((area.x + area.w) * AMOSTRA_L);
  const y1 = Math.round((area.y + area.h) * AMOSTRA_A);
  if (x1 - x0 < 12 || y1 - y0 < 12) return null;

  const salto = 3;
  const candidatos = [
    diferencaEntreLinhas(buf, 'x', x1, y0 + 3, y1 - 3, salto),  // borda direita
    diferencaEntreLinhas(buf, 'x', x0, y0 + 3, y1 - 3, salto),  // borda esquerda
    diferencaEntreLinhas(buf, 'y', y1, x0 + 3, x1 - 3, salto),  // borda de baixo
    diferencaEntreLinhas(buf, 'y', y0, x0 + 3, x1 - 3, salto),  // borda de cima
  ].filter((v) => v != null);

  if (!candidatos.length) return null;

  // Referencia: o quanto a imagem muda naturalmente na mesma distancia.
  const referencias = [];
  for (let f = 0.2; f <= 0.8; f += 0.15) {
    const d1 = diferencaEntreLinhas(buf, 'x', Math.round(AMOSTRA_L * f), 20, AMOSTRA_A - 20, salto);
    const d2 = diferencaEntreLinhas(buf, 'y', Math.round(AMOSTRA_A * f), 20, AMOSTRA_L - 20, salto);
    if (d1 != null) referencias.push(d1);
    if (d2 != null) referencias.push(d2);
  }
  const base = referencias.length
    ? referencias.reduce((a, b) => a + b, 0) / referencias.length : 1;

  const maiorBorda = Math.max.apply(null, candidatos);
  return maiorBorda / Math.max(1.5, base);
}

/**
 * Olha alguns instantes do trecho e diz se a webcam esta separada ali.
 * @returns {object} { temWebcam, forca, amostras }
 */
async function detectarWebcam(video, inicio, duracao, area) {
  const instantes = [inicio + duracao * 0.15, inicio + duracao * 0.5, inicio + duracao * 0.85];
  const forcas = [];

  for (const t of instantes) {
    try {
      const buf = await amostrarFrame(video, t);
      if (!buf) continue;
      const f = medirBordaDaWebcam(buf, area);
      if (f != null) forcas.push(f);
    } catch (_) { /* um frame ruim nao invalida a analise */ }
  }

  if (!forcas.length) return { temWebcam: true, forca: 0, amostras: 0 };

  // 1.55x a variacao normal da imagem ja e uma moldura bem marcada
  const acimaDoLimiar = forcas.filter((f) => f >= 1.55).length;
  const media = forcas.reduce((a, b) => a + b, 0) / forcas.length;

  return {
    temWebcam: acimaDoLimiar >= Math.ceil(forcas.length / 2),
    forca: Math.round(media * 100) / 100,
    amostras: forcas.length,
    misto: acimaDoLimiar > 0 && acimaDoLimiar < forcas.length,
  };
}

/** Um frame cru do video, pro usuario marcar onde esta a webcam e o jogo. */
async function gerarFrame(video, segundo, destino, largura) {
  const { ffmpeg } = await garantirFfmpeg();
  await rodar(ffmpeg, [
    '-y', '-ss', String(Math.max(0, segundo)), '-i', video,
    '-frames:v', '1', '-vf', 'scale=' + (largura || 960) + ':-2',
    '-q:v', '3', '-loglevel', 'error', destino,
  ]);
  return destino;
}

/** Um frame ja montado no formato final - serve pra conferir antes de gerar tudo. */
async function gerarPrevia(video, segundo, formato, recorte, destino) {
  const { ffmpeg } = await garantirFfmpeg();
  const filtro = filtroDeFormato(formato, recorte);

  const args = ['-y', '-ss', String(Math.max(0, segundo)), '-i', video, '-frames:v', '1'];
  if (filtro) args.push('-filter_complex', filtro, '-map', '[v]');
  args.push('-q:v', '3', '-loglevel', 'error', destino);

  await rodar(ffmpeg, args);
  return destino;
}

module.exports = {
  garantirFfmpeg,
  inspecionar,
  extrairAudio,
  energiaPorSegundo,
  cortarClipe,
  gerarMiniatura,
  gerarFrame,
  detectarWebcam,
  gerarPrevia,
  filtroDeFormato,
};
