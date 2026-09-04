'use strict';
/** Baixa o video direto do YouTube (ou de qualquer link que o yt-dlp entenda). */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
// Em servidor os videos baixados vao pro volume persistente (DADOS); no PC
// continuam dentro da propria pasta do projeto, como sempre foi.
const BAIXADOS = process.env.DADOS ? path.join(process.env.DADOS, 'baixados') : path.join(RAIZ, 'baixados');

// Mesma historia do ffmpeg: o winget instala mas o PATH so vale em processo
// novo. No Linux/container o Dockerfile poe o caminho certo em YTDLP_PATH.
function acharYtDlp() {
  if (process.env.YTDLP_PATH) return [process.env.YTDLP_PATH];

  if (process.platform !== 'win32') {
    return ['yt-dlp', '/opt/venv/bin/yt-dlp', '/usr/local/bin/yt-dlp'];
  }

  const candidatos = ['yt-dlp.exe'];
  const base = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!/yt-dlp/i.test(dir)) continue;
      const raiz = path.join(base, dir);
      for (const nome of fs.readdirSync(raiz)) {
        if (/^yt-dlp.*\.exe$/i.test(nome)) candidatos.push(path.join(raiz, nome));
      }
    }
  } catch (_) { /* pasta do winget pode nao existir */ }
  candidatos.push(path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'yt-dlp.exe'));
  return candidatos;
}

let YTDLP = null;

function testar(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, ['--version'], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

async function garantirYtDlp() {
  if (YTDLP) return YTDLP;
  for (const c of acharYtDlp()) {
    if (await testar(c)) { YTDLP = c; return YTDLP; }
  }
  throw new Error('Nao encontrei o yt-dlp. Rode o instalar.bat de novo.');
}

/** Aceita link do YouTube em qualquer formato, e tambem de outros sites. */
function pareceLink(texto) {
  return /^https?:\/\/[^\s]+$/i.test(String(texto || '').trim());
}

/**
 * A Kick tem dois formatos de link pro mesmo video: o da barra de endereco
 * (kick.com/canal/videos/uuid), que o yt-dlp entende, e o do botao de
 * compartilhar (kick.com/video/uuid), que ele nao reconhece e trata como
 * pagina generica - dando 404. Aqui a gente descobre o canal e reescreve.
 */
function descobrirCanalDaKick(uuid) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get('https://kick.com/api/v1/video/' + uuid, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const canal = (j.livestream && j.livestream.channel && j.livestream.channel.slug) ||
                        (j.channel && j.channel.slug) || null;
          resolve(canal);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function normalizarUrl(url) {
  const u = String(url || '').trim();
  const m = /^https?:\/\/(?:www\.)?kick\.com\/video\/([0-9a-fA-F-]{20,})/.exec(u);
  if (!m) return u;

  const canal = await descobrirCanalDaKick(m[1]);
  return canal ? 'https://kick.com/' + canal + '/videos/' + m[1] : u;
}

function limparNome(s) {
  return String(s || 'video')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 60) || 'video';
}

/**
 * Titulo e duracao antes de baixar. Tenta os mesmos caminhos do download:
 * de nada adianta o download saber furar o Cloudflare se a consulta que vem
 * antes dele morre na porta.
 */
async function espiar(url) {
  url = await normalizarUrl(url);
  const tentativas = estrategiasPara(url).slice(0, 3);
  let ultimo = null;
  for (const e of tentativas) {
    try { return await espiarUma(url, e.args || []); }
    catch (err) {
      ultimo = err;
      if (semJeito(err.message)) throw err;
    }
  }
  throw ultimo || new Error('Nao consegui ler esse link.');
}

function espiarUma(url, extras) {
  return garantirYtDlp().then((bin) => new Promise((resolve, reject) => {
    const p = spawn(bin, ['--no-warnings', '--dump-single-json', '--no-playlist']
      .concat(extras, [url]), { windowsHide: true });
    let saida = '';
    let erro = '';
    p.stdout.on('data', (d) => { saida += d.toString(); });
    p.stderr.on('data', (d) => { erro += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(mensagemDeErro(erro)));
      try {
        const j = JSON.parse(saida);
        resolve({
          titulo: j.title || 'video',
          duracao: Number(j.duration || 0),
          canal: j.uploader || j.channel || '',
          largura: j.width || 0,
          altura: j.height || 0,
        });
      } catch (e) { reject(new Error('Nao consegui ler os dados desse link.')); }
    });
  }));
}

/** Traduz o erro do yt-dlp pra algo que ajude quem esta na frente da tela. */
function mensagemDeErro(bruto) {
  const t = String(bruto || '');
  if (/private video/i.test(t)) return 'Esse video e privado.';
  if (/members-only|join this channel/i.test(t)) return 'Esse video e so para membros do canal.';
  if (/sign in to confirm|not a bot|cookies/i.test(t)) {
    return 'O YouTube pediu login pra esse video. Baixe o arquivo na mao e use a opcao de escolher o arquivo.';
  }
  if (/video unavailable|not available/i.test(t)) return 'Esse video esta indisponivel.';
  if (/age.?restrict/i.test(t)) return 'Esse video tem restricao de idade.';
  if (/unsupported url|no video/i.test(t)) return 'Nao reconheci esse link como um video.';
  // 404 no extrator generico quase sempre e link no formato que o site nao expoe
  if (/HTTP Error 404/i.test(t)) {
    return 'Esse link nao levou a nenhum video. Copie o endereco direto da barra do navegador, ' +
           'com o video aberto (na Kick fica assim: kick.com/canal/videos/...).';
  }
  if (/HTTP Error 4\d\d/i.test(t)) return 'O site recusou o download desse video.';
  if (/urlopen error|getaddrinfo|network/i.test(t)) return 'Sem conexao com a internet.';

  const ultima = t.split(/\r?\n/).filter((l) => /ERROR/i.test(l)).pop();
  return ultima ? ultima.replace(/^ERROR:\s*/i, '').slice(0, 200) : 'O download falhou.';
}

/**
 * Baixa o video.
 * @param {string} url
 * @param {object} opcoes  { limiteAltura }  1080 por padrao; 0 = melhor que existir
 * @param {function} aoProgredir  (fracao 0..1, mensagem)
 * @returns {Promise<string>} caminho do arquivo baixado
 */
/**
 * O YouTube muda o jeito de servir video toda hora, e o yt-dlp so acompanha se
 * estiver atualizado. Foi exatamente isso que quebrou aqui: uma versao de dois
 * meses atras tomava 403 em tudo. Entao, quando o download falha por bloqueio,
 * a gente atualiza sozinho e tenta de novo antes de dar erro pro usuario.
 */
function pareceDesatualizado(msg) {
  return /403|forbidden|recusou|nao consegui ler|precisa ser recarregad|reloaded|format is not available|formato/i.test(String(msg));
}

function atualizarYtDlp(bin) {
  // '-U' so funciona no binario standalone (pyinstaller) do Windows. Instalado
  // via pip num venv Linux ele sempre falha, e o processo roda como usuario
  // sem permissao de escrever no proprio venv de qualquer forma. Em servidor
  // quem atualiza o yt-dlp e o rebuild da imagem, nao o processo em producao.
  if (process.platform !== 'win32') return Promise.resolve(false);

  return new Promise((resolve) => {
    const p = spawn(bin, ['-U'], { windowsHide: true });
    let saida = '';
    p.stdout.on('data', (d) => { saida += d.toString(); });
    p.stderr.on('data', (d) => { saida += d.toString(); });
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(/Updated yt-dlp|is up to date/i.test(saida)));
  });
}

/**
 * Cada video do YouTube responde melhor a um caminho diferente, e o que
 * funciona hoje pode ser bloqueado amanha. Entao em vez de uma tentativa so,
 * a gente percorre uma fila de estrategias ate alguma entregar o arquivo.
 */
const ESTRATEGIAS_YOUTUBE = [
  { nome: 'normal', args: [] },
  { nome: 'cliente padrao', args: ['--extractor-args', 'youtube:player_client=default'] },
  { nome: 'cliente da TV', args: ['--extractor-args', 'youtube:player_client=tv_embedded'] },
  { nome: 'cliente do celular', args: ['--extractor-args', 'youtube:player_client=android_vr'] },
  { nome: 'qualquer formato', args: [], formatoLivre: true },
];

/**
 * Kick, Twitch e afins ficam atras de Cloudflare, que barra pela impressao
 * digital da conexao. O --impersonate faz o yt-dlp se apresentar como um
 * navegador de verdade; os cookies do navegador resolvem o que exige login.
 */
const ESTRATEGIAS_GERAIS_BASE = [
  { nome: 'normal', args: [] },
  { nome: 'fingindo ser o Chrome', args: ['--impersonate', 'chrome'] },
  { nome: 'fingindo ser o Edge', args: ['--impersonate', 'edge'] },
  { nome: 'com os cookies do seu Chrome', args: ['--cookies-from-browser', 'chrome'], soWindows: true },
  { nome: 'com os cookies do seu Edge', args: ['--cookies-from-browser', 'edge'], soWindows: true },
  { nome: 'qualquer formato', args: ['--impersonate', 'chrome'], formatoLivre: true },
];

// Num servidor Linux nao existe perfil de Chrome/Edge instalado - essas duas
// tentativas sempre falhariam, so gastando tempo antes da que funciona de verdade.
const ESTRATEGIAS_GERAIS = process.platform === 'win32'
  ? ESTRATEGIAS_GERAIS_BASE
  : ESTRATEGIAS_GERAIS_BASE.filter((e) => !e.soWindows);

function estrategiasPara(url) {
  return /youtube\.com|youtu\.be/i.test(String(url)) ? ESTRATEGIAS_YOUTUBE : ESTRATEGIAS_GERAIS;
}

/** Nao adianta insistir quando o motivo nao muda com outra tentativa. */
function semJeito(msg) {
  return /privado|so para membros|restricao de idade|indisponivel|nao reconheci|Sem conexao|pediu login/i.test(String(msg));
}

async function baixar(url, opcoes, aoProgredir) {
  opcoes = opcoes || {};
  url = await normalizarUrl(url);
  let ultimoErro = null;
  let jaAtualizou = false;

  const estrategias = estrategiasPara(url);
  for (let i = 0; i < estrategias.length; i++) {
    const e = estrategias[i];
    try {
      if (i > 0 && aoProgredir) {
        aoProgredir(0, 'Recusado. Tentando ' + e.nome + '...');
      }
      return await tentarBaixar(url, opcoes, aoProgredir, e);
    } catch (err) {
      ultimoErro = err;
      if (semJeito(err.message)) throw err;   // insistir nao vai mudar nada

      // Na primeira recusa, atualiza o baixador: quase sempre e isso.
      if (!jaAtualizou && estrategias === ESTRATEGIAS_YOUTUBE) {
        jaAtualizou = true;
        if (aoProgredir) aoProgredir(0, 'Atualizando o baixador...');
        try { await atualizarYtDlp(await garantirYtDlp()); } catch (_) {}
      }
    }
  }

  // Guarda o erro cru num log: a mensagem amigavel some da tela, mas quando
  // um video especifico nao baixa, o motivo tecnico esta aqui pra investigar.
  try {
    const pastaTrabalho = process.env.DADOS ? path.join(process.env.DADOS, 'trabalho') : path.join(RAIZ, 'trabalho');
    fs.mkdirSync(pastaTrabalho, { recursive: true });
    fs.appendFileSync(
      path.join(pastaTrabalho, 'erros-download.log'),
      '\n=== ' + new Date().toISOString() + ' ===\n' +
      'link: ' + url + '\n' +
      'todas as ' + estrategias.length + ' tentativas falharam\n' +
      'ultimo erro: ' + ((ultimoErro && ultimoErro.bruto) || (ultimoErro && ultimoErro.message) || '?') + '\n',
      'utf8'
    );
  } catch (_) { /* log e diagnostico, nao pode derrubar nada */ }

  const base = (ultimoErro && ultimoErro.message) || 'O download falhou.';
  throw new Error(base + ' Tentei ' + estrategias.length + ' caminhos diferentes. Baixe o arquivo por fora e use "Arraste um vídeo do seu PC".');
}

async function tentarBaixar(url, opcoes, aoProgredir, estrategia) {
  opcoes = opcoes || {};
  estrategia = estrategia || { args: [] };
  const bin = await garantirYtDlp();
  fs.mkdirSync(BAIXADOS, { recursive: true });

  const limite = opcoes.limiteAltura === 0 ? null : (opcoes.limiteAltura || 1080);

  // Pede H.264 (avc1) na frente de tudo por dois motivos: o YouTube costuma
  // devolver 403 nos formatos AV1 mais novos, e o ffmpeg processa H.264 bem
  // mais rapido na hora de cortar - que e o que a gente faz logo depois.
  const alt = limite ? '[height<=' + limite + ']' : '';
  const formato = estrategia.formatoLivre
    ? (limite ? 'b' + alt + '/bv*' + alt + '+ba/b/bv*+ba' : 'b/bv*+ba')
    : [
        'bv*[vcodec^=avc1]' + alt + '+ba[acodec^=mp4a]',
        'bv*[vcodec^=avc1]' + alt + '+ba',
        'bv*' + alt + '+ba',
        'b' + alt,
        'bv*+ba/b',
      ].join('/');

  const modelo = path.join(BAIXADOS, '%(title).60B [%(id)s].%(ext)s');

  return new Promise((resolve, reject) => {
    const args = [
      '--no-warnings', '--no-playlist', '--newline',
      ...(estrategia.args || []),
      '--retries', '5', '--fragment-retries', '10',
      '--concurrent-fragments', '4',
      '--no-part',                       // evita ficar com .part se cair a conexao
      '-f', formato,
      '--merge-output-format', 'mp4',
      '--restrict-filenames',            // sem acento e sem espaco: menos dor de cabeca depois
      '-o', modelo,
      '--progress',
      // Nada de --print aqui: ele desliga o relatorio de progresso do yt-dlp,
      // e ai o usuario fica olhando uma barra parada num download de 500 MB.
      // O caminho do arquivo a gente tira das proprias mensagens abaixo.
      url,
    ];

    const p = spawn(bin, args, { windowsHide: true });
    let caminho = '';
    let erro = '';
    const restos = { out: '', err: '' };

    // Com --print ligado, o yt-dlp joga o progresso no stderr e deixa o stdout
    // so pro caminho do arquivo. Entao a gente le as duas saidas do mesmo jeito.
    function processar(texto, qual) {
      restos[qual] += texto;
      const linhas = restos[qual].split(/\r?\n/);
      restos[qual] = linhas.pop();

      for (const linha of linhas) {
        const t = linha.trim();
        if (!t) continue;

        // De onde sai o caminho final, em ordem de confianca:
        // o Merger diz o arquivo juntado; o Destination, o arquivo unico.
        const juntou = /\[Merger\]\s+Merging formats into\s+"(.+?)"/i.exec(t);
        if (juntou) { caminho = juntou[1]; }

        const destino = /\[download\]\s+Destination:\s+(.+\.(?:mp4|mkv|webm|mov))\s*$/i.exec(t);
        if (destino && !caminho) { caminho = destino[1].trim(); }

        const jaTinha = /\[download\]\s+(.+\.(?:mp4|mkv|webm|mov))\s+has already been downloaded/i.exec(t);
        if (jaTinha) { caminho = jaTinha[1].trim(); }

        const m = /\[download\]\s+([\d.]+)%/.exec(t);
        if (m && aoProgredir) {
          const frac = Math.min(1, Number(m[1]) / 100);
          const vel = (/at\s+([\d.]+\s*\w+\/s)/.exec(t) || [])[1];
          const total = (/of\s+~?([\d.]+\s*\w+)/.exec(t) || [])[1];
          aoProgredir(frac, 'Baixando... ' + Math.round(frac * 100) + '%' +
            (total ? ' de ' + total : '') + (vel ? '  ·  ' + vel : ''));
        } else if (/\[Merger\]|\[ffmpeg\]/i.test(t) && aoProgredir) {
          aoProgredir(0.97, 'Juntando video e audio...');
        }
      }
    }

    p.stdout.on('data', (d) => processar(d.toString(), 'out'));
    p.stderr.on('data', (d) => {
      const t = d.toString();
      erro += t;
      processar(t, 'err');
    });
    p.on('error', (e) => reject(new Error('Nao consegui rodar o yt-dlp: ' + e.message)));

    p.on('close', (code) => {
      if (code !== 0) {
        const e = new Error(mensagemDeErro(erro));
        e.bruto = erro
          .split(String.fromCharCode(10))
          .filter(function (l) { return (/ERROR|WARNING/i).test(l); })
          .slice(-4).join(" | ");
        return reject(e);
      }

      if (caminho && fs.existsSync(caminho)) return resolve(caminho);

      // Rede de seguranca: pega o arquivo de video mais novo da pasta
      try {
        const recente = fs.readdirSync(BAIXADOS)
          .filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(BAIXADOS, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)[0];
        if (recente) return resolve(path.join(BAIXADOS, recente.f));
      } catch (_) { /* cai no erro abaixo */ }

      reject(new Error('O download terminou mas nao achei o arquivo.'));
    });
  });
}

module.exports = { baixar, espiar, garantirYtDlp, pareceLink, BAIXADOS };
