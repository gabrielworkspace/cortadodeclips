'use strict';
/**
 * Monta a legenda .ass no estilo dos cortes que rodam bem:
 * poucas palavras por vez, fonte grossa com contorno preto e a palavra
 * que esta sendo dita naquele instante destacada em amarelo.
 */

const fs = require('fs');

const PALAVRAS_POR_BLOCO = 3;

// Cores no formato ASS: &HAABBGGRR (sim, e BGR invertido)
const BRANCO = '&H00FFFFFF';
const AMARELO = '&H0000E5FF';
const PRETO = '&H00000000';

function tempoAss(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + seg.toFixed(2).padStart(5, '0');
}

function escapar(t) {
  return String(t)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function cabecalho(opcoes) {
  const fonte = opcoes.fonte || 'Arial Black';
  const tamanho = opcoes.tamanho || 78;
  const margemBaixo = opcoes.margemBaixo || 300;
  const margemGancho = opcoes.margemGancho || 150;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Corte,' + fonte + ',' + tamanho + ',' + BRANCO + ',' + AMARELO + ',' + PRETO + ',&H64000000,' +
      '-1,0,0,0,100,100,1,0,1,7,4,2,70,70,' + margemBaixo + ',1',
    // Alignment 8 = topo centralizado. BorderStyle 3 desenha uma tarja atras do
    // texto, que e o que faz o gancho ser legivel por cima de qualquer gameplay.
    'Style: Gancho,' + fonte + ',' + (opcoes.tamanhoGancho || 62) + ',' + BRANCO + ',' + BRANCO + ',' + PRETO + ',&HC8000000,' +
      '-1,0,0,0,100,100,0,0,3,10,0,8,60,60,' + margemGancho + ',1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

/**
 * Quebra o gancho em 2 linhas equilibradas. Uma linha muito comprida some
 * na lateral do celular e ninguem le a tempo.
 */
function quebrarGancho(texto, porLinha) {
  const palavras = String(texto).split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    if (atual && (atual + ' ' + p).length > porLinha) { linhas.push(atual); atual = p; }
    else atual = atual ? atual + ' ' + p : p;
  }
  if (atual) linhas.push(atual);
  return linhas.slice(0, 3).join('\\N');
}

/**
 * @param {Array} palavras  [{inicio, fim, texto}] em tempo ABSOLUTO do video
 * @param {number} offset   segundo em que o clipe comeca (pra zerar o tempo)
 * @param {string} destino  caminho do .ass
 */
function gerarAss(palavras, offset, destino, opcoes) {
  opcoes = opcoes || {};
  const linhas = [cabecalho(opcoes)];

  // O gancho fica na tela nos primeiros segundos. E o que segura quem parou de
  // rolar antes mesmo de entender o audio - e muita gente assiste sem som.
  if (opcoes.gancho) {
    const duracao = Math.max(2, Math.min(8, opcoes.duracaoGancho || 4));
    // Emoji some do texto queimado: a fonte do video renderiza ele como um
    // quadradinho preto. No titulo que a pessoa copia pra legenda, ele fica.
    const semEmoji = String(opcoes.gancho)
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
      .replace(/\s+/g, ' ').trim();
    if (semEmoji.length >= 8) {
      const texto = quebrarGancho(escapar(semEmoji).toUpperCase(), 26);
      linhas.push(
        'Dialogue: 1,' + tempoAss(0) + ',' + tempoAss(duracao) + ',Gancho,,0,0,0,,' +
        '{\\fad(180,320)}' + texto
      );
    }
  }

  // A legenda palavra-por-palavra e o gancho sao independentes: a pessoa pode
  // querer so o gancho no topo, sem a legenda embaixo cobrindo o resto do video.
  const blocos = [];
  if (opcoes.incluirPalavras !== false) {
    // Agrupa em blocos curtos - texto comprido na tela ninguem le
    for (let i = 0; i < palavras.length; i += PALAVRAS_POR_BLOCO) {
      const grupo = palavras.slice(i, i + PALAVRAS_POR_BLOCO);
      if (grupo.length) blocos.push(grupo);
    }
  }

  for (const bloco of blocos) {
    for (let i = 0; i < bloco.length; i++) {
      const atual = bloco[i];
      const inicio = Math.max(0, atual.inicio - offset);
      // A ultima palavra do bloco segura ate a proxima comecar (evita piscada)
      const proxima = bloco[i + 1];
      const fim = Math.max(inicio + 0.12, (proxima ? proxima.inicio : atual.fim + 0.18) - offset);

      const texto = bloco.map((p, j) => {
        const limpo = escapar(p.texto);
        if (j === i) {
          // palavra sendo dita: amarela e um tico maior
          return '{\\c' + AMARELO + '\\fscx108\\fscy108}' + limpo + '{\\c' + BRANCO + '\\fscx100\\fscy100}';
        }
        return limpo;
      }).join(' ');

      linhas.push(
        'Dialogue: 0,' + tempoAss(inicio) + ',' + tempoAss(fim) + ',Corte,,0,0,0,,' + texto
      );
    }
  }

  fs.writeFileSync(destino, linhas.join('\n'), 'utf8');
  return destino;
}

/** Legenda .srt simples, pra quem quiser editar depois no CapCut/Premiere. */
function gerarSrt(palavras, offset, destino) {
  const blocos = [];
  for (let i = 0; i < palavras.length; i += 8) {
    const g = palavras.slice(i, i + 8);
    if (g.length) blocos.push(g);
  }

  const partes = blocos.map((g, idx) => {
    const ini = Math.max(0, g[0].inicio - offset);
    const fim = Math.max(ini + 0.3, g[g.length - 1].fim - offset);
    return [
      String(idx + 1),
      tempoSrt(ini) + ' --> ' + tempoSrt(fim),
      g.map((p) => p.texto).join(' ').replace(/\s+/g, ' ').trim(),
      '',
    ].join('\n');
  });

  fs.writeFileSync(destino, partes.join('\n'), 'utf8');
  return destino;
}

function tempoSrt(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
         String(seg).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
}

module.exports = { gerarAss, gerarSrt };
