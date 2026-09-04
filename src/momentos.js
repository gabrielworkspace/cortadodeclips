'use strict';
/**
 * Acha os momentos de PICO do video - aqueles em que algo acontece.
 *
 * O resto do sistema escuta o que foi dito. Isso aqui resolve o caso em que a
 * fala nao e o ponto: abertura de carta, sorteio, reacao, susto. Nesses videos
 * ninguem para pelo argumento; para pela revelacao. E revelacao deixa duas
 * marcas: a voz explode e a imagem muda.
 */

const { spawn } = require('child_process');
const fs = require('fs');

// ---------------------------------------------------------------- audio

/**
 * Energia do audio numa resolucao fina o bastante pra pegar o instante do grito.
 * @param {string} wav   PCM 16 bits mono 16kHz (o mesmo que vai pro Whisper)
 * @param {number} passo em segundos (0.25 = 4 medidas por segundo)
 */
function energiaFina(wav, passo) {
  passo = passo || 0.25;
  const buf = fs.readFileSync(wav);
  const inicio = acharDados(buf);
  const amostrasPorBloco = Math.max(1, Math.round(16000 * passo));
  const bytesPorBloco = amostrasPorBloco * 2;
  const total = Math.floor((buf.length - inicio) / bytesPorBloco);

  const valores = new Array(total);
  for (let b = 0; b < total; b++) {
    const base = inicio + b * bytesPorBloco;
    let soma = 0, n = 0;
    for (let i = 0; i < amostrasPorBloco; i += 4) {
      const v = buf.readInt16LE(base + i * 2) / 32768;
      soma += v * v;
      n++;
    }
    valores[b] = Math.sqrt(soma / Math.max(1, n));
  }
  return { valores, passo };
}

function acharDados(buf) {
  let pos = 12;
  while (pos + 8 < buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const tam = buf.readUInt32LE(pos + 4);
    if (id === 'data') return pos + 8;
    pos += 8 + tam + (tam % 2);
  }
  return 44;
}

function mediana(lista) {
  const o = lista.slice().sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)] || 0;
}

/**
 * Momentos em que a voz sobe muito acima do normal daquele video - grito,
 * risada, "NAO ACREDITO". Comparamos cada instante com a vizinhanca dele, e
 * nao com a media geral: assim funciona tanto em quem fala baixo quanto em
 * quem grita o video inteiro.
 */
function picosDeVoz(wav, opcoes) {
  opcoes = opcoes || {};
  const { valores, passo } = energiaFina(wav, 0.25);
  if (valores.length < 40) return [];

  const janelaVizinha = Math.round(20 / passo);   // 20 segundos de contexto
  const picos = [];

  for (let i = 2; i < valores.length - 2; i++) {
    const a = Math.max(0, i - janelaVizinha);
    const b = Math.min(valores.length, i + janelaVizinha);
    const vizinhanca = valores.slice(a, b);
    const base = mediana(vizinhanca);
    if (base <= 0.0001) continue;

    const razao = valores[i] / base;

    // precisa ser maximo local, senao um grito longo vira 30 picos
    const ehTopo = valores[i] >= valores[i - 1] && valores[i] >= valores[i + 1] &&
                   valores[i] >= valores[i - 2] && valores[i] >= valores[i + 2];

    if (razao >= 2.3 && ehTopo && valores[i] > 0.09) {
      picos.push({ tempo: i * passo, forca: Math.min(3.2, razao), tipo: 'voz' });
    }
  }

  return juntarProximos(picos, 2.5);
}

/** Dois picos colados sao o mesmo acontecimento. Fica o mais forte. */
function juntarProximos(picos, distancia) {
  picos.sort((a, b) => a.tempo - b.tempo);
  const saida = [];
  for (const p of picos) {
    const ultimo = saida[saida.length - 1];
    if (ultimo && p.tempo - ultimo.tempo < distancia) {
      if (p.forca > ultimo.forca) saida[saida.length - 1] = p;
    } else saida.push(p);
  }
  return saida;
}

/**
 * O silencio ANTES do pico e o que faz o pico valer. Em abertura de carta e
 * sorteio, a sequencia e sempre a mesma: suspense, revelacao, explosao.
 * Marcamos isso porque o corte tem que comecar no suspense, nao no grito.
 */
function marcarSuspense(picos, wav) {
  const { valores, passo } = energiaFina(wav, 0.25);
  const olhar = Math.round(3 / passo);

  for (const p of picos) {
    const i = Math.round(p.tempo / passo);
    const antes = valores.slice(Math.max(0, i - olhar), Math.max(1, i - 1));
    if (!antes.length) continue;
    const calmaria = mediana(antes);
    p.contraste = calmaria > 0.0001 ? valores[i] / calmaria : 1;
    p.temSuspense = p.contraste >= 2.4;
  }
  return picos;
}

// ---------------------------------------------------------------- video

/**
 * Mudancas bruscas de imagem: corte de camera, zoom na carta, entrada de
 * animacao. Roda numa versao minusucla do video pra nao custar caro.
 */
function mudancasDeCena(ffmpeg, video, aoProgredir, duracaoTotal) {
  return new Promise((resolve) => {
    const args = [
      '-i', video,
      '-filter:v', "scale=160:-2,fps=5,select='gt(scene,0.22)',showinfo",
      '-an', '-f', 'null', '-',
      '-loglevel', 'info',
    ];

    const p = spawn(ffmpeg, args, { windowsHide: true });
    const achados = [];
    let resto = '';

    p.stderr.on('data', (d) => {
      resto += d.toString();
      const linhas = resto.split(/\r?\n/);
      resto = linhas.pop();
      for (const l of linhas) {
        const m = /pts_time:([\d.]+)/.exec(l);
        if (m) achados.push({ tempo: Number(m[1]), forca: 1, tipo: 'cena' });
        else if (aoProgredir && duracaoTotal) {
          const t = /time=(\d+):(\d+):([\d.]+)/.exec(l);
          if (t) {
            const seg = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
            aoProgredir(Math.min(1, seg / duracaoTotal));
          }
        }
      }
    });

    p.on('error', () => resolve([]));
    p.on('close', () => resolve(juntarProximos(achados, 1.5)));
  });
}

// ---------------------------------------------------------------- combinar

/**
 * Junta o que o ouvido e o olho acharam. Um momento que tem grito E mudanca de
 * imagem ao mesmo tempo e quase sempre o pico real do video.
 */
function combinar(picosVoz, picosCena) {
  const todos = picosVoz.map((p) => Object.assign({}, p));

  for (const c of picosCena) {
    const perto = todos.find((v) => Math.abs(v.tempo - c.tempo) <= 2.0);
    if (perto) {
      perto.forca += 0.8;
      perto.tipo = 'voz+cena';
    }
  }

  // Rajada de cortes de cena tambem e sinal: alguem editou aquilo com capricho
  const densidade = new Map();
  for (const c of picosCena) {
    const chave = Math.floor(c.tempo / 10);
    densidade.set(chave, (densidade.get(chave) || 0) + 1);
  }
  for (const t of todos) {
    const n = densidade.get(Math.floor(t.tempo / 10)) || 0;
    if (n >= 3) t.forca += 0.4;
  }

  return todos.sort((a, b) => b.forca - a.forca);
}

/**
 * @returns {Promise<Array>} [{ tempo, forca, tipo, temSuspense, contraste }]
 */
async function detectar(opcoes) {
  const { wav, video, ffmpeg, usarVideo, aoProgredir, duracao } = opcoes;

  let voz = [];
  try { voz = marcarSuspense(picosDeVoz(wav), wav); } catch (_) { voz = []; }

  let cena = [];
  if (usarVideo !== false && ffmpeg && video) {
    try { cena = await mudancasDeCena(ffmpeg, video, aoProgredir, duracao); } catch (_) { cena = []; }
  }

  const todos = combinar(voz, cena);

  // Se tudo e pico, nada e pico: com 50 marcacoes num video de 15 min, todo
  // trecho ganharia bonus e o ranking perderia sentido. Fica so o topo, numa
  // quantidade proporcional ao tamanho do video.
  const limite = Math.max(8, Math.round((duracao || 600) / 60 * 1.5));
  return todos.slice(0, limite);
}

module.exports = { detectar, picosDeVoz, mudancasDeCena, energiaFina };
