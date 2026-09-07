'use strict';
/** Do arquivo de video ate os clipes prontos na pasta de saida. */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const media = require('./media');
const legenda = require('./legenda');
const momentos = require('./momentos');
const { encontrarCortes, achatarPalavras, mmss } = require('./score');
const { gerarCopy, gerarGanchoDeTela } = require('./copy');
const { interpretar } = require('./intencao');

const RAIZ = path.join(__dirname, '..');
// Em servidor, tudo que o app grava vai pro volume persistente (DADOS) - senao
// some a cada deploy, porque a imagem do container e descartavel. No PC local
// continua igual a sempre: dentro da propria pasta do projeto.
const DADOS = process.env.DADOS || RAIZ;
const TRABALHO = path.join(DADOS, 'trabalho');
const SAIDA = path.join(DADOS, 'saida');
const MODELOS = process.env.MODELOS_DIR || path.join(RAIZ, 'modelos');

// ---------------------------------------------------------------- python

function acharPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;

  if (process.platform !== 'win32') return 'python3';  // 'python' sozinho nao existe no Debian

  const tentativas = [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  for (const v of ['313', '312', '311', '310']) {
    tentativas.push(path.join(local, 'Programs', 'Python', 'Python' + v, 'python.exe'));
  }
  for (const v of ['313', '312', '311', '310']) {
    tentativas.push(path.join('C:', 'Python' + v, 'python.exe'));
  }
  for (const t of tentativas) if (fs.existsSync(t)) return t;
  return 'python';
}

// ---------------------------------------------------------------- utilidades

function limparNome(s) {
  return String(s || 'clipe')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'clipe';
}

function assinaturaDoArquivo(arquivo) {
  const st = fs.statSync(arquivo);
  return crypto.createHash('sha1')
    .update(arquivo + '|' + st.size + '|' + Math.round(st.mtimeMs))
    .digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- transcricao

function transcrever(audio, destinoJson, duracao, modelo, idioma, aoProgredir) {
  return new Promise((resolve, reject) => {
    const py = acharPython();
    const script = path.join(RAIZ, 'py', 'transcrever.py');
    const p = spawn(py, [
      script,
      '--audio', audio,
      '--saida', destinoJson,
      '--modelo', modelo || 'small',
      '--idioma', idioma || 'pt',
      '--duracao', String(duracao || 0),
    ], {
      windowsHide: true,
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',
        HF_HOME: process.env.HF_HOME || MODELOS,
        // Em container, os.cpus() enxerga os nucleos do HOST, nao a cota da
        // maquina (cgroup). Numa VM de 2 vCPU rodando num host de 48 nucleos
        // isso pediria 46 threads: contexto trocando o tempo todo e a
        // transcricao fica MAIS LENTA do que com poucas threads. NUM_THREADS
        // deixa o dono do servidor fixar o numero certo.
        OMP_NUM_THREADS: process.env.NUM_THREADS || String(Math.max(1, os.cpus().length - 2)),
      }),
    });

    let resto = '';
    let erroFinal = '';

    p.stdout.on('data', (d) => {
      resto += d.toString();
      const linhas = resto.split(/\r?\n/);
      resto = linhas.pop();
      for (const linha of linhas) {
        const t = linha.trim();
        if (!t.startsWith('{')) continue;
        let ev;
        try { ev = JSON.parse(t); } catch (_) { continue; }
        if (ev.tipo === 'progresso' && aoProgredir) aoProgredir(ev.pct, ev.msg);
        if (ev.tipo === 'erro') erroFinal = ev.msg;
      }
    });

    p.stderr.on('data', (d) => {
      const t = d.toString();
      if (/error|Error|Traceback/.test(t)) erroFinal = erroFinal || t.split(/\r?\n/).slice(-6).join('\n');
    });

    p.on('error', (e) => reject(new Error('Nao consegui rodar o Python: ' + e.message)));
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(destinoJson)) resolve(JSON.parse(fs.readFileSync(destinoJson, 'utf8')));
      else reject(new Error(erroFinal || 'A transcricao falhou (codigo ' + code + ').'));
    });
  });
}

// ---------------------------------------------------------------- principal

/**
 * @param {object} opcoes  { video, formato, legendar, quantidade, minDur, maxDur, modelo, idioma, usarIA, chaveIA }
 * @param {function} avisar  (evento) => void
 */
async function processar(opcoes, avisar) {
  const video = opcoes.video;
  if (!fs.existsSync(video)) throw new Error('Nao achei esse arquivo: ' + video);

  fs.mkdirSync(TRABALHO, { recursive: true });
  fs.mkdirSync(SAIDA, { recursive: true });

  const emitir = (pct, etapa, msg) => avisar({ tipo: 'progresso', pct: Math.round(pct * 10) / 10, etapa, msg });

  // ---- 1. inspecionar
  emitir(1, 'lendo', 'Abrindo o video...');
  await media.garantirFfmpeg();
  const info = await media.inspecionar(video);
  if (!info.temAudio) throw new Error('Esse video nao tem faixa de audio - sem audio nao da pra transcrever.');
  if (info.duracao < 40) throw new Error('Video curto demais (' + Math.round(info.duracao) + 's). Preciso de pelo menos 40 segundos.');

  avisar({
    tipo: 'info',
    duracao: info.duracao,
    duracaoTexto: mmss(info.duracao),
    largura: info.largura,
    altura: info.altura,
    arquivo: path.basename(video),
  });

  const assinatura = assinaturaDoArquivo(video);
  const wav = path.join(TRABALHO, assinatura + '.wav');
  // o v2 no nome invalida o cache quando a gente muda como transcreve
  const jsonTranscricao = path.join(TRABALHO, assinatura + '-' + (opcoes.modelo || 'small') + '-v2.json');

  // ---- 2. audio
  if (!fs.existsSync(wav)) {
    emitir(2, 'audio', 'Separando o audio do video...');
    await media.extrairAudio(video, wav, info.duracao, (frac) => {
      emitir(2 + frac * 5, 'audio', 'Separando o audio... ' + Math.round(frac * 100) + '%');
    });
  } else {
    emitir(7, 'audio', 'Audio ja estava pronto de uma rodada anterior.');
  }

  // ---- 3. transcricao (a parte demorada)
  let transcricao;
  if (fs.existsSync(jsonTranscricao)) {
    emitir(60, 'transcricao', 'Transcricao ja existia - reaproveitando.');
    transcricao = JSON.parse(fs.readFileSync(jsonTranscricao, 'utf8'));
  } else {
    emitir(8, 'transcricao', 'Comecando a ouvir o video inteiro...');
    transcricao = await transcrever(
      wav, jsonTranscricao, info.duracao, opcoes.modelo, opcoes.idioma,
      (pct, msg) => {
        // o python vai de 2 a 94; aqui isso vira 8 a 60
        const p = 8 + (Math.max(0, Math.min(94, pct)) / 94) * 52;
        emitir(p, 'transcricao', msg);
      }
    );
  }

  // ---- 4. energia do audio
  emitir(61, 'analise', 'Medindo a energia da fala...');
  let energia = [];
  try { energia = media.energiaPorSegundo(wav); } catch (_) { energia = []; }

  // ---- 4b. picos de reacao e mudanca de imagem
  // Em video de abertura de carta ou sorteio, o que prende nao esta na frase:
  // esta no instante da revelacao. Sem isso o sistema so enxerga argumento.
  let picos = [];
  if (opcoes.detectarMomentos !== false) {
    emitir(62, 'analise', 'Procurando os momentos de reacao...');
    try {
      const { ffmpeg } = await media.garantirFfmpeg();
      picos = await momentos.detectar({
        wav,
        video,
        ffmpeg,
        duracao: info.duracao,
        usarVideo: opcoes.olharImagem !== false,
        aoProgredir: (frac) => emitir(62 + frac * 2, 'analise',
          'Procurando os momentos de reacao... ' + Math.round(frac * 100) + '%'),
      });
      if (picos.length) {
        avisar({ tipo: 'aviso', msg: 'Achei ' + picos.length + ' momentos de pico no video.' });
      }
    } catch (e) {
      avisar({ tipo: 'aviso', msg: 'Nao consegui analisar os picos (' + e.message + ').' });
    }
  }

  // A descricao escrita manda no perfil, a nao ser que a pessoa tenha
  // escolhido um explicitamente na tela.
  const intencao = interpretar(opcoes.descricao);
  const perfilFinal = opcoes.perfil && opcoes.perfil !== "auto" ? opcoes.perfil : intencao.perfil;
  if (intencao.resumo) avisar({ tipo: "aviso", msg: "Procurando: " + intencao.resumo });

  // ---- 5. escolher os melhores momentos
  emitir(64, 'analise', 'Procurando os melhores momentos...');
  let cortes = encontrarCortes(transcricao, energia, {
    quantidade: opcoes.quantidade || 8,
    minDur: opcoes.minDur || 28,
    maxDur: opcoes.maxDur || 62,
    momentos: picos,
    perfil: perfilFinal,
    intencao: intencao,
  });

  if (!cortes.length) throw new Error('Nao consegui montar nenhum corte. O video pode ter pouca fala.');

  // Curadoria opcional pela IA da Anthropic - so quando ha chave
  if (opcoes.usarIA && opcoes.chaveIA) {
    try {
      emitir(65, 'analise', 'Pedindo pra IA revisar a escolha dos cortes...');
      const { revisarComIA } = require('./ia');
      cortes = await revisarComIA(cortes, transcricao, opcoes.chaveIA, (m) => emitir(66, 'analise', m));
    } catch (e) {
      avisar({ tipo: 'aviso', msg: 'A IA nao respondeu (' + e.message + '). Segui com a analise local.' });
    }
  }

  cortes = ordenarCortes(cortes, opcoes.ordem);

  // A copy do post: titulo que promete algo, sempre baseado no que foi dito
  const contexto = path.basename(video, path.extname(video));
  for (const c of cortes) {
    const cp = gerarCopy(c, contexto);
    c.titulo = cp.titulo;
    c.titulos = cp.titulos;
  }
  avisar({ tipo: 'cortes', cortes: cortes.map(semPalavras) });

  // ---- 6. gerar os arquivos
  const nomeBase = limparNome(path.basename(video, path.extname(video)));
  const carimbo = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const pastaSaida = path.join(SAIDA, nomeBase + '_' + carimbo);
  fs.mkdirSync(pastaSaida, { recursive: true });

  const vertical = opcoes.formato !== 'original';
  const prontos = [];

  for (let i = 0; i < cortes.length; i++) {
    const c = cortes[i];
    // O gancho fica guardado no clipe: e o texto que a pessoa vai querer
    // reescrever depois, quando bater o olho no resultado e pensar em algo melhor.
    c.gancho = opcoes.textoGancho !== false ? gerarGanchoDeTela(c) : null;

    // A nota entra no nome: assim o ranking aparece na pasta do Windows tambem
    const base = 'clipe-' + String(i + 1).padStart(2, '0') +
                 '-nota' + c.nota + '-' + limparNome(c.titulo);

    const p0 = 68 + (i / cortes.length) * 30;
    const p1 = 68 + ((i + 1) / cortes.length) * 30;
    const rotuloEtapa = 'clipe ' + (i + 1) + ' de ' + cortes.length;
    emitir(p0, 'cortando', 'Gerando o ' + rotuloEtapa + '...');

    const pronto = await renderizarClipe({
      video: video,
      assinatura: assinatura,
      pastaSaida: pastaSaida,
      base: base,
      opcoes: opcoes,
      vertical: vertical,
      avisar: avisar,
      aoProgredir: (frac, msg) => emitir(p0 + (p1 - p0) * frac, 'cortando', msg),
      rotulo: rotuloEtapa,
    }, c);

    prontos.push(pronto);
    avisar({ tipo: 'clipe-pronto', clipe: pronto });
  }

  // Guarda o que um "refazer" precisa saber. Sem isso, mudar o gancho ou
  // esticar dois segundos de um clipe obrigaria a transcrever o video de novo.
  gravarSessao(pastaSaida, {
    video: video,
    assinatura: assinatura,
    transcricao: jsonTranscricao,
    duracaoVideo: info.duracao,
    opcoes: opcoes,
    clipes: prontos,
  });

  // ---- 7. relatorio
  const relatorio = {
    videoOriginal: video,
    duracaoOriginal: info.duracao,
    gerado: new Date().toISOString(),
    formato: opcoes.formato,
    legendado: !!(opcoes.legendar && vertical),
    clipes: prontos,
  };
  fs.writeFileSync(path.join(pastaSaida, 'relatorio.json'), JSON.stringify(relatorio, null, 2), 'utf8');
  fs.writeFileSync(path.join(pastaSaida, 'RELATORIO.txt'), textoDoRelatorio(relatorio), 'utf8');

  emitir(100, 'pronto', 'Tudo pronto! ' + prontos.length + ' clipes na pasta de saida.');
  avisar({ tipo: 'fim', pasta: pastaSaida, clipes: prontos });

  return { pasta: pastaSaida, clipes: prontos };
}

/**
 * Onde a legenda fica na vertical, em pixels a partir de baixo (tela de 1920).
 * No split, ela precisa cair sobre o gameplay - se ficar colada no rodape
 * some atras da barra de progresso do TikTok.
 */
function margemDaLegenda(opcoes, formatoEfetivo) {
  const formato = formatoEfetivo || opcoes.formato;
  // Se o clipe caiu pra vertical porque nao tinha webcam, a legenda nao pode
  // ficar na altura que faria sentido no split - ela ficaria no meio da tela.
  if (opcoes.margemLegenda && formato === opcoes.formato) {
    return Math.max(60, Math.min(1400, opcoes.margemLegenda));
  }
  return formato === 'split' ? 430 : 300;
}

/**
 * Ordem em que os clipes saem. O padrao e por nota: o clipe-01 e sempre o de
 * maior chance de viralizar, entao da pra comecar a postar antes mesmo de
 * terminar de gerar o resto.
 */
function ordenarCortes(cortes, ordem) {
  const lista = cortes.slice();

  if (ordem === 'tempo') lista.sort((a, b) => a.inicio - b.inicio);
  else lista.sort((a, b) => (b.nota - a.nota) || (a.inicio - b.inicio));

  lista.forEach((c, i) => { c.numero = i + 1; });
  return lista;
}

function semPalavras(c) {
  const copia = Object.assign({}, c);
  delete copia.palavras;
  return copia;
}

function textoDoRelatorio(r) {
  const linhas = [];
  linhas.push('CORTES GERADOS');
  linhas.push('='.repeat(70));
  linhas.push('Video: ' + path.basename(r.videoOriginal));
  linhas.push('Duracao original: ' + mmss(r.duracaoOriginal));
  linhas.push('Formato: ' + r.formato + (r.legendado ? ' com legenda queimada' : ''));
  linhas.push('Gerado em: ' + new Date(r.gerado).toLocaleString('pt-BR'));
  linhas.push('');

  for (const c of r.clipes) {
    linhas.push('-'.repeat(70));
    linhas.push('CLIPE ' + c.numero + '  |  nota de engajamento: ' + c.nota + '/100 (' + c.rotulo.texto + ')');
    linhas.push('Titulo sugerido: ' + c.titulo);
    linhas.push('No video original: ' + c.inicioTexto + ' ate ' + c.fimTexto + '  (' + c.duracao + 's)');
    linhas.push('Arquivo: ' + c.nomeArquivo);
    if (c.tags && c.tags.length) linhas.push('Hashtags: ' + c.tags.map((t) => '#' + t).join(' '));
    linhas.push('Por que pontuou: ' + c.motivos.map((m) => m.fator + ' (' + (m.pontos > 0 ? '+' : '') + m.pontos + ')').join(', '));
    linhas.push('');
    linhas.push('Transcricao:');
    linhas.push(quebrar(c.texto, 68));
    linhas.push('');
  }
  return linhas.join('\n');
}

function quebrar(texto, largura) {
  const palavras = String(texto).split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    if ((atual + ' ' + p).trim().length > largura) { linhas.push(atual.trim()); atual = p; }
    else atual += ' ' + p;
  }
  if (atual.trim()) linhas.push(atual.trim());
  return linhas.join('\n');
}


// ---------------------------------------------------------------- um clipe

/**
 * Gera UM clipe: confere o enquadramento, monta a legenda, corta e faz a
 * miniatura. Vive separado do laco principal porque o "refazer" usa exatamente
 * o mesmo caminho - so muda o corte que entra.
 *
 * @param {object} ctx  { video, assinatura, pastaSaida, base, opcoes, vertical,
 *                        avisar, aoProgredir, rotulo }
 * @param {object} c    o corte: { inicio, duracao, palavras, gancho, ... }
 */
async function renderizarClipe(ctx, c) {
  const opcoes = ctx.opcoes || {};
  const avisar = ctx.avisar || (() => {});
  const aoProgredir = ctx.aoProgredir || (() => {});
  const rotulo = ctx.rotulo || 'clipe';
  const mp4 = path.join(ctx.pastaSaida, ctx.base + '.mp4');

  // O layout do video muda ao longo da gravacao: as vezes e webcam + gameplay,
  // as vezes o streamer poe a cara em tela cheia. Aplicar o split nesse segundo
  // caso recorta o rosto em dois pedacos empilhados. Entao a gente confere
  // trecho a trecho se a janelinha da webcam esta mesmo ali.
  let formatoDoClipe = opcoes.formato || 'vertical';
  let observacao = null;

  // Quando ele poe a cara em tela cheia, nao existe webcam separada pra
  // recortar: o rosto JA e o video inteiro. Manter o split ali empilha dois
  // pedacos do proprio rosto e ainda desenha uma linha no meio dele. Nesses
  // trechos o certo e o oposto - foco so na cara, sem divisao nenhuma.
  if (formatoDoClipe === 'split' && opcoes.detectarWebcam !== false &&
      opcoes.recorte && opcoes.recorte.topo) {
    aoProgredir(0, 'Conferindo o enquadramento do ' + rotulo + '...');
    const d = await media.detectarWebcam(ctx.video, c.inicio, c.duracao, opcoes.recorte.topo);

    if (!d.temWebcam) {
      formatoDoClipe = opcoes.formatoSemWebcam || 'vertical';
      observacao = 'Aqui aparece so a cara dele - foquei no rosto, sem a divisao.';
      avisar({ tipo: 'aviso', msg: 'No ' + rotulo + ' so aparece a cara dele: foquei no rosto, sem divisao.' });
    } else if (d.misto) {
      observacao = 'O layout muda no meio desse trecho - confira o resultado.';
    }
  }

  // .ass fica na pasta trabalho e o ffmpeg roda com cwd la:
  // caminho curto e sem espaco evita problema de escape no filtro
  //
  // Legenda palavra-a-palavra e gancho na tela sao dois recursos separados
  // pra quem usa o programa - desligar um nao pode apagar o outro.
  const querLegenda = !!opcoes.legendar;
  const gancho = c.gancho || null;

  let arquivoAss = null;
  if ((querLegenda || gancho) && ctx.vertical) {
    arquivoAss = 'leg-' + ctx.assinatura + '-' + limparNome(ctx.base) + '.ass';
    legenda.gerarAss(c.palavras || [], c.inicio, path.join(TRABALHO, arquivoAss), {
      tamanho: opcoes.tamanhoLegenda || 78,
      margemBaixo: margemDaLegenda(opcoes, formatoDoClipe),
      incluirPalavras: querLegenda,
      // O gancho da TELA e diferente do titulo do post: ele precisa criar
      // lacuna em 2 linhas, nao resumir o trecho.
      gancho: gancho,
      duracaoGancho: opcoes.duracaoGancho || 4,
      margemGancho: formatoDoClipe === 'split' ? 660 : 180,
    });
  }

  await media.cortarClipe({
    video: ctx.video,
    inicio: c.inicio,
    duracao: c.duracao,
    destino: mp4,
    formato: formatoDoClipe,
    recorte: opcoes.recorte,
    qualidade: opcoes.qualidade || 'maxima',
    arquivoAss,
    pastaTrabalho: TRABALHO,
    aoProgredir: (frac) => aoProgredir(frac,
      'Gerando o ' + rotulo + '... ' + Math.round(frac * 100) + '%'),
  });

  // legenda solta, pra editar depois
  legenda.gerarSrt(c.palavras || [], c.inicio, path.join(ctx.pastaSaida, ctx.base + '.srt'));

  const miniatura = path.join(ctx.pastaSaida, ctx.base + '.jpg');
  await media.gerarMiniatura(ctx.video, c.inicio + c.duracao / 2, miniatura, ctx.vertical);

  if (arquivoAss) { try { fs.unlinkSync(path.join(TRABALHO, arquivoAss)); } catch (_) {} }

  return Object.assign(semPalavras(c), {
    arquivo: mp4,
    nomeArquivo: path.basename(mp4),
    base: ctx.base,
    formatoUsado: formatoDoClipe,
    observacao,
    miniatura: fs.existsSync(miniatura) ? miniatura : null,
    tamanhoMb: Math.round((fs.statSync(mp4).size / 1048576) * 10) / 10,
  });
}

// ---------------------------------------------------------------- refazer

const ARQUIVO_SESSAO = 'sessao.json';

function gravarSessao(pasta, dados) {
  try {
    fs.writeFileSync(path.join(pasta, ARQUIVO_SESSAO), JSON.stringify(dados, null, 2), 'utf8');
  } catch (_) {}
}

function lerSessao(pasta) {
  const arquivo = path.join(pasta, ARQUIVO_SESSAO);
  if (!fs.existsSync(arquivo)) {
    throw new Error('Essa pasta e de uma versao antiga do programa e nao guarda o que preciso pra refazer. Gere os cortes de novo.');
  }
  return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
}

/**
 * Refaz um clipe que ja existe com outro gancho e/ou outro comeco e fim.
 * Nao transcreve nada de novo: pega as palavras da transcricao guardada e
 * recorta o pedaco novo. Por isso leva segundos, nao minutos.
 *
 * @param {object} pedido  { pasta, numero, inicio, duracao, gancho }
 */
async function refazerClipe(pedido, avisar) {
  avisar = avisar || (() => {});
  const emitir = (pct, msg) => avisar({ tipo: 'progresso', pct: Math.round(pct), etapa: 'cortando', msg });

  const sessao = lerSessao(pedido.pasta);
  const antigo = (sessao.clipes || []).find((c) => c.numero === Number(pedido.numero));
  if (!antigo) throw new Error('Nao achei o clipe ' + pedido.numero + ' nessa pasta.');
  if (!fs.existsSync(sessao.video)) {
    throw new Error('O video original saiu do lugar: ' + sessao.video);
  }

  emitir(4, 'Preparando o clipe ' + antigo.numero + '...');
  await media.garantirFfmpeg();

  // Onde o clipe comeca e termina agora. O minimo e 3s porque abaixo disso
  // nao cabe nem o gancho; o maximo e o que sobra ate o fim do video.
  const limite = sessao.duracaoVideo || Infinity;
  let inicio = pedido.inicio == null ? antigo.inicio : Number(pedido.inicio);
  let duracao = pedido.duracao == null ? antigo.duracao : Number(pedido.duracao);
  if (!isFinite(inicio)) inicio = antigo.inicio;
  if (!isFinite(duracao)) duracao = antigo.duracao;
  inicio = Math.max(0, Math.min(inicio, Math.max(0, limite - 3)));
  duracao = Math.max(3, Math.min(duracao, limite - inicio));
  inicio = Math.round(inicio * 100) / 100;
  duracao = Math.round(duracao * 10) / 10;

  // As palavras do trecho novo saem da transcricao que ja esta no disco.
  let palavras = [];
  let texto = antigo.texto;
  if (sessao.transcricao && fs.existsSync(sessao.transcricao)) {
    const t = JSON.parse(fs.readFileSync(sessao.transcricao, 'utf8'));
    const todas = achatarPalavras(t);
    palavras = todas.filter((p) => p.fim > inicio && p.inicio < inicio + duracao);
    texto = palavras.map((p) => p.texto).join(' ').replace(/\s+/g, ' ').trim() || antigo.texto;
  } else {
    avisar({ tipo: 'aviso', msg: 'A transcricao saiu do cache: refiz o video, mas sem legenda nova.' });
  }

  // undefined = nao mexeu no gancho; string vazia = quer sem gancho nenhum
  const gancho = pedido.gancho === undefined
    ? (antigo.gancho || null)
    : (String(pedido.gancho).trim() || null);

  const corte = Object.assign({}, antigo, {
    inicio: inicio,
    duracao: duracao,
    fim: Math.round((inicio + duracao) * 100) / 100,
    inicioTexto: mmss(inicio),
    fimTexto: mmss(inicio + duracao),
    palavras: palavras,
    texto: texto,
    gancho: gancho,
    editado: true,
  });

  const pronto = await renderizarClipe({
    video: sessao.video,
    assinatura: sessao.assinatura,
    pastaSaida: pedido.pasta,
    base: antigo.base || path.basename(antigo.nomeArquivo, '.mp4'),
    opcoes: sessao.opcoes || {},
    vertical: (sessao.opcoes || {}).formato !== 'original',
    avisar: avisar,
    aoProgredir: (frac, msg) => emitir(8 + frac * 88, msg),
    rotulo: 'clipe ' + antigo.numero,
  }, corte);

  // Guarda o clipe novo no lugar do antigo, pra um proximo ajuste partir daqui
  sessao.clipes = (sessao.clipes || []).map((c) => (c.numero === pronto.numero ? pronto : c));
  gravarSessao(pedido.pasta, sessao);
  regravarRelatorio(pedido.pasta, sessao);

  emitir(100, 'Clipe ' + pronto.numero + ' refeito.');
  avisar({ tipo: 'clipe-refeito', clipe: pronto });
  return pronto;
}

/** Mantem o RELATORIO.txt e o relatorio.json de acordo com o que foi refeito. */
function regravarRelatorio(pasta, sessao) {
  const arquivo = path.join(pasta, 'relatorio.json');
  if (!fs.existsSync(arquivo)) return;
  try {
    const r = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    r.clipes = sessao.clipes;
    fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), 'utf8');
    fs.writeFileSync(path.join(pasta, 'RELATORIO.txt'), textoDoRelatorio(r), 'utf8');
  } catch (_) {}
}

module.exports = { processar, refazerClipe, SAIDA, TRABALHO };
