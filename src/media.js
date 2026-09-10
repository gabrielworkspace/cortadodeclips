'use strict';
/** Tudo que fala com ffmpeg: inspecionar, extrair audio, medir energia e cortar. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// No Windows o winget instala o ffmpeg mas o PATH so vale em processo novo,
// entao procuramos nos lugares conhecidos do WinGet. No Linux/container o
// Da pra apontar um binario proprio por variavel de ambiente ou pelo PATH.
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
 * Confere se da pra usar a animacao pedida e normaliza os numeros.
 * Um gif que sumiu do disco nao pode derrubar a geracao inteira - nesse caso
 * o clipe sai sem animacao, igual a antes.
 * @returns {object|null} { arquivo, cobertura, opacidade }
 */
function animacaoValida(a) {
  if (!a || !a.arquivo) return null;
  try { if (!fs.statSync(a.arquivo).isFile()) return null; } catch (_) { return null; }
  return {
    arquivo: a.arquivo,
    // quanto do clipe ela cobre, contado do comeco
    cobertura: Math.max(0.05, Math.min(1, Number(a.cobertura) || 0.6)),
    opacidade: Math.max(0.1, Math.min(1, a.opacidade == null ? 1 : Number(a.opacidade))),
  };
}

/**
 * Corta um clipe.
 * @param {object} o { video, inicio, duracao, destino, formato, arquivoAss,
 *                     animacao, pastaTrabalho, aoProgredir }
 */
async function cortarClipe(o) {
  const { ffmpeg } = await garantirFfmpeg();

  const anim = animacaoValida(o.animacao);

  // Sem reenquadrar, sem legenda e sem animacao nao ha nada pra desenhar:
  // copiamos o fluxo original bit a bit. Zero recodificacao, zero perda.
  if (o.formato === 'original' && !o.arquivoAss && !anim) {
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
  ];

  // O gif entra como segundo input. -ignore_loop 0 faz ele repetir sozinho:
  // a animacao tem 11s e o clipe tem 30 e poucos, entao sem loop ela sumiria
  // no meio do caminho.
  if (anim) args.push('-ignore_loop', '0', '-i', anim.arquivo);

  // -t vai depois de TODOS os inputs, pra valer como opcao de saida. Se ficar
  // entre os inputs ele passa a limitar o input seguinte, e ai quem manda no
  // tamanho do arquivo vira o gif em loop infinito - o clipe saia com minutos.
  args.push('-t', String(o.duracao));

  const filtroBase = filtroDeFormato(o.formato, o.recorte);
  // A legenda entra depois do enquadramento, ja no tamanho final.
  // Rodamos o ffmpeg com cwd na pasta do .ass e passamos so o nome:
  // isso evita todo o inferno de escapar caminho do Windows no filtro.
  const legenda = o.arquivoAss ? "subtitles=" + o.arquivoAss : null;

  // Monta a corrente em etapas, cada uma pegando o rotulo que a anterior
  // deixou. Assim enquadramento, legenda e animacao entram em qualquer
  // combinacao sem uma precisar saber da outra.
  const partes = [];
  let rotulo = '[0:v]';
  if (filtroBase) { partes.push(filtroBase); rotulo = '[v]'; }

  // A animacao entra ANTES da legenda de proposito: ela ocupa a tela inteira,
  // e se viesse por ultimo passaria por cima do gancho. Texto ilegivel derruba
  // o corte inteiro; a animacao atras nao atrapalha nada.
  if (anim) {
    const ate = (o.duracao * anim.cobertura).toFixed(2);
    // format=rgba mantem o fundo transparente do gif; sem isso ele vira
    // um retangulo preto por cima do video.
    let prep = '[1:v]format=rgba,scale=' + LARGURA + ':' + ALTURA +
               ':force_original_aspect_ratio=decrease:flags=lanczos';
    if (anim.opacidade < 1) {
      prep += ',colorchannelmixer=aa=' + anim.opacidade.toFixed(2);
    }
    partes.push(prep + '[anim]');
    partes.push(rotulo + '[anim]overlay=(W-w)/2:(H-h)/2:' +
                "enable='lte(t," + ate + ")'[vanim]");
    rotulo = '[vanim]';
  }

  if (legenda) { partes.push(rotulo + legenda + '[vleg]'); rotulo = '[vleg]'; }

  if (partes.length) {
    args.push('-filter_complex', partes.join(';'), '-map', rotulo, '-map', '0:a?');
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
 * Mede so as bordas que ficam POR CIMA do video (as que nao encostam na beirada
 * da tela), e devolve a mais fraca delas.
 *
 * Usar a borda mais fraca, e nao a mais forte, e o que separa uma webcam de
 * verdade de um acaso: a janela da webcam tem moldura marcada em TODOS os lados
 * que ficam sobre o gameplay. Um pedaco qualquer de cenario pode ter uma linha
 * forte de um lado so - e essa, no minimo, cai fora.
 */
function forcaDaMolduraInteira(buf, area) {
  const x0 = Math.round(area.x * AMOSTRA_L);
  const y0 = Math.round(area.y * AMOSTRA_A);
  const x1 = Math.round((area.x + area.w) * AMOSTRA_L);
  const y1 = Math.round((area.y + area.h) * AMOSTRA_A);
  if (x1 - x0 < 12 || y1 - y0 < 12) return null;

  const salto = 3;
  const margem = 4;   // encostado na beirada da tela nao conta como moldura
  const bordas = [];

  if (x0 > margem) bordas.push(diferencaEntreLinhas(buf, 'x', x0, y0 + 3, y1 - 3, salto));
  if (x1 < AMOSTRA_L - margem) bordas.push(diferencaEntreLinhas(buf, 'x', x1, y0 + 3, y1 - 3, salto));
  if (y0 > margem) bordas.push(diferencaEntreLinhas(buf, 'y', y0, x0 + 3, x1 - 3, salto));
  if (y1 < AMOSTRA_A - margem) bordas.push(diferencaEntreLinhas(buf, 'y', y1, x0 + 3, x1 - 3, salto));

  const validas = bordas.filter((v) => v != null);
  if (validas.length < 2) return null;   // sem pelo menos 2 lados sobre o video, nao da pra afirmar nada

  const referencias = [];
  for (let f = 0.2; f <= 0.8; f += 0.15) {
    const d1 = diferencaEntreLinhas(buf, 'x', Math.round(AMOSTRA_L * f), 20, AMOSTRA_A - 20, salto);
    const d2 = diferencaEntreLinhas(buf, 'y', Math.round(AMOSTRA_A * f), 20, AMOSTRA_L - 20, salto);
    if (d1 != null) referencias.push(d1);
    if (d2 != null) referencias.push(d2);
  }
  const base = referencias.length
    ? referencias.reduce((a, b) => a + b, 0) / referencias.length : 1;

  return Math.min.apply(null, validas) / Math.max(1.5, base);
}

/** Mudanca media de cor entre dois frames, dentro de uma area. */
function mudancaEntreFrames(b1, b2, area) {
  const x0 = Math.round(area.x * AMOSTRA_L);
  const y0 = Math.round(area.y * AMOSTRA_A);
  const x1 = Math.round((area.x + area.w) * AMOSTRA_L);
  const y1 = Math.round((area.y + area.h) * AMOSTRA_A);
  let soma = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * AMOSTRA_L + x) * 3;
      soma += (Math.abs(b1[i] - b2[i]) + Math.abs(b1[i + 1] - b2[i + 1]) + Math.abs(b1[i + 2] - b2[i + 2])) / 3;
      n++;
    }
  }
  return n ? soma / n : 0;
}

/**
 * Procura a webcam sozinho, varrendo os cantos do video.
 *
 * O sinal que funciona nao e a moldura (o HUD do jogo tem bordas retas tao
 * fortes quanto) nem o tom de pele (cenario de Roblox e cheio de marrom que
 * passa por pele). E a ESTABILIDADE NO TEMPO: entre dois momentos distantes do
 * video o gameplay muda por completo, enquanto a webcam continua mostrando a
 * mesma pessoa, no mesmo lugar, com o mesmo fundo. A janela da webcam e, de
 * longe, a regiao que menos muda.
 *
 * Isso importa porque marcar essa caixa no canto errado estraga TODOS os
 * clipes de uma vez, e em silencio: o programa recorta um pedaco de cenario
 * pro topo e ainda conclui "ele esta em tela cheia" quando nao acha moldura.
 *
 * @returns {Promise<object|null>} { area, canto, estabilidade } ou null
 */
async function acharWebcam(video, duracao) {
  const dur = duracao || 600;
  // Bem espalhados de proposito: se os frames forem proximos, o gameplay
  // tambem parece estavel e o sinal some.
  const instantes = [0.15, 0.35, 0.55, 0.75, 0.9].map((f) => Math.max(1, dur * f));

  const frames = [];
  for (const t of instantes) {
    try {
      const buf = await amostrarFrame(video, t);
      if (buf) frames.push(buf);
    } catch (_) { /* um frame ruim nao invalida a busca */ }
  }
  if (frames.length < 3) return null;

  function mudancaMedia(area) {
    let soma = 0, pares = 0;
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        soma += mudancaEntreFrames(frames[i], frames[j], area);
        pares++;
      }
    }
    return pares ? soma / pares : 0;
  }

  // Referencia: o quanto a tela inteira muda entre esses mesmos momentos.
  const geral = mudancaMedia({ x: 0, y: 0, w: 1, h: 1 });
  if (geral < 5) return null;   // video praticamente parado: nao da pra concluir nada

  const m = 0.005;
  const tamanhos = [{ w: 0.18, h: 0.24 }, { w: 0.23, h: 0.30 }, { w: 0.28, h: 0.37 }, { w: 0.33, h: 0.44 }];
  const cantos = [
    { nome: 'superior esquerdo', x: () => m, y: () => m },
    { nome: 'superior direito', x: (t) => 1 - t.w - m, y: () => m },
    { nome: 'inferior esquerdo', x: () => m, y: (t) => 1 - t.h - m },
    { nome: 'inferior direito', x: (t) => 1 - t.w - m, y: (t) => 1 - t.h - m },
  ];

  let melhor = null;
  for (const c of cantos) {
    for (const t of tamanhos) {
      const area = { x: c.x(t), y: c.y(t), w: t.w, h: t.h };
      const razao = mudancaMedia(area) / geral;   // quanto menor, mais estavel
      if (!melhor || razao < melhor.razao) {
        melhor = { area, canto: c.nome, razao };
      }
    }
  }

  // Precisa mudar bem menos que a tela toda pra ser webcam, e nao um pedaco
  // de cenario que por acaso ficou parado.
  if (!melhor || melhor.razao > 0.62) return null;

  return {
    area: melhor.area,
    canto: melhor.canto,
    estabilidade: Math.round((1 - melhor.razao) * 100),   // 0 a 100, quanto maior mais confianca
  };
}

/**
 * Olha alguns instantes do trecho e diz se a webcam esta separada ali.
 * @returns {object} { temWebcam, forca, amostras }
 */
async function detectarWebcam(video, inicio, duracao, area) {
  // Aqui NAO da pra usar a moldura como sinal: em gameplay de Roblox a tela
  // toda e cheia de linhas retas fortes (HUD, shop, inventario), entao a
  // moldura da webcam nao se destaca e a medicao acusa "sem webcam" com a
  // webcam na tela - estragando o corte.
  //
  // O sinal certo e o mesmo que acha a webcam: ESTABILIDADE. Dentro do trecho,
  // a janelinha da webcam muda pouco (mesma pessoa, mesmo fundo) enquanto o
  // gameplay muda muito. Se a regiao da webcam mudar tanto quanto o resto da
  // tela, e porque nao tem webcam ali - o quadro inteiro virou a cara dele.
  const instantes = [0.12, 0.35, 0.6, 0.85].map((f) => inicio + duracao * f);

  const frames = [];
  for (const t of instantes) {
    try {
      const buf = await amostrarFrame(video, t);
      if (buf) frames.push(buf);
    } catch (_) { /* um frame ruim nao invalida a analise */ }
  }

  // Sem material pra decidir: assume o formato normal do canal, que e o que
  // acerta na maioria dos trechos.
  if (frames.length < 2) return { temWebcam: true, razao: null, amostras: frames.length };

  function mudancaMedia(alvo) {
    let soma = 0, pares = 0;
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        soma += mudancaEntreFrames(frames[i], frames[j], alvo);
        pares++;
      }
    }
    return pares ? soma / pares : 0;
  }

  const geral = mudancaMedia({ x: 0, y: 0, w: 1, h: 1 });
  // Cena parada (menu, pausa): nao da pra separar webcam de gameplay porque
  // nada se move. Mantem o formato do canal.
  if (geral < 4) return { temWebcam: true, razao: null, amostras: frames.length };

  const naWebcam = mudancaMedia(area);
  const razao = naWebcam / geral;

  // Nenhum sinal sozinho e confiavel:
  //  - a ESTABILIDADE falha quando o gameplay esta parado e ele gesticula
  //    falando: a webcam muda mais que a tela e parece nao existir;
  //  - a MOLDURA falha porque o HUD do jogo tem linhas retas tao fortes quanto.
  //
  // Trocar o enquadramento sem necessidade estraga o corte, enquanto deixar de
  // trocar so mantem o formato de sempre. Como errar custa caro e nao errar
  // custa pouco, so mudamos quando os DOIS sinais concordam que a webcam sumiu.
  const bordas = [];
  for (const buf of frames) {
    const f = medirBordaDaWebcam(buf, area);
    if (f != null) bordas.push(f);
  }
  bordas.sort((a, b) => a - b);
  const bordaMediana = bordas.length ? bordas[Math.floor(bordas.length / 2)] : null;

  const estabilidadeDiz = razao >= 0.78;                        // regiao muda quase tanto quanto a tela
  const molduraDiz = bordaMediana != null && bordaMediana < 1.2; // sem quebra de imagem na borda
  const semWebcam = estabilidadeDiz && molduraDiz;

  return {
    temWebcam: !semWebcam,
    razao: Math.round(razao * 100) / 100,
    borda: bordaMediana == null ? null : Math.round(bordaMediana * 100) / 100,
    amostras: frames.length,
    // Faixa cinzenta: um sinal aponta pra tela cheia e o outro nao. Nao troca
    // o enquadramento, mas avisa pra pessoa conferir aquele clipe.
    misto: estabilidadeDiz !== molduraDiz,
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
  acharWebcam,
  gerarPrevia,
  filtroDeFormato,
};
