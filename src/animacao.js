'use strict';
/**
 * As animacoes que entram por cima do clipe.
 *
 * Sao gifs de fundo transparente, no tamanho do video vertical (1080x1920),
 * guardados na pasta `animacoes/`. Cada tipo de conteudo pode ter o seu -
 * o de Street Fighter foi o primeiro.
 *
 * Pra adicionar outra, basta jogar o .gif na pasta: ela aparece na lista
 * sozinha, sem mexer em codigo.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PASTA = process.env.ANIMACOES_DIR || path.join(RAIZ, 'animacoes');

const EXTENSOES = ['.gif', '.webm', '.mov', '.mp4', '.apng', '.png'];

/** Nome bonito pro que aparece na tela, a partir do nome do arquivo. */
function nomeLegivel(arquivo) {
  return path.basename(arquivo, path.extname(arquivo))
    .replace(/[\[\]_]+/g, ' ')
    .replace(/\bGIF\b/gi, '')
    .replace(/\bSEM FUNDO\b/gi, '')
    .replace(/\bANIMA[CÇ][AÃ]O\b/gi, '')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || path.basename(arquivo);
}

/** @returns {Array<{id, nome, arquivo, tamanhoMb}>} */
function listar() {
  let nomes;
  try { nomes = fs.readdirSync(PASTA); } catch (_) { return []; }

  return nomes
    .filter((n) => EXTENSOES.includes(path.extname(n).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'pt-BR'))
    .map((n) => {
      const arquivo = path.join(PASTA, n);
      let tamanhoMb = null;
      try { tamanhoMb = Math.round((fs.statSync(arquivo).size / 1048576) * 10) / 10; } catch (_) {}
      return { id: n, nome: nomeLegivel(n), arquivo, tamanhoMb };
    });
}

/**
 * Do id que veio da janela pro caminho no disco.
 *
 * O id e so o nome do arquivo, e a checagem garante que ele resolve pra
 * dentro da pasta de animacoes - senao um id com ".." viraria um jeito de
 * apontar pra qualquer arquivo da maquina.
 *
 * @returns {string|null} caminho absoluto, ou null se nao existir
 */
function resolver(id) {
  if (!id) return null;
  const alvo = path.resolve(PASTA, String(id));
  const rel = path.relative(path.resolve(PASTA), alvo);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { return fs.statSync(alvo).isFile() ? alvo : null; } catch (_) { return null; }
}

module.exports = { listar, resolver, PASTA };
