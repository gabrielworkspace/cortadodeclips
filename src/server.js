'use strict';
/** Servidor local que serve a janela e roda o processamento. */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { URL } = require('url');

const { processar, SAIDA, TRABALHO } = require('./pipeline');
const media = require('./media');
const baixador = require('./baixar');

const RAIZ = path.join(__dirname, '..');
// PORT e o nome que as nuvens usam; PORTA e o nosso, pra rodar local.
const PORTA_INICIAL = Number(process.env.PORT || process.env.PORTA || 4321);

// Em servidor (Docker/nuvem) precisa escutar em tudo; no PC de casa fica so no
// loopback, a nao ser que a pessoa peca a rede pra usar o celular.
const NA_REDE = process.env.REDE === '1' || process.env.HOST === '0.0.0.0' || !!process.env.PORT;
const HOST = NA_REDE ? '0.0.0.0' : '127.0.0.1';

const trabalhos = new Map(); // id -> { eventos: [], ouvintes: Set, terminou }
let jobAtivo = false;        // uma transcricao por vez - CPU pesada nao divide bem

// ---------------------------------------------------------------- helpers

function json(res, codigo, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
  });
  res.end(texto);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      if (dados.length > 2e6) { req.destroy(); reject(new Error('corpo grande demais')); }
    });
    req.on('end', () => {
      try { resolve(dados ? JSON.parse(dados) : {}); }
      catch (e) { reject(new Error('json invalido')); }
    });
    req.on('error', reject);
  });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Serve arquivo do disco com suporte a Range (o video precisa disso). */
function servirArquivo(req, res, arquivo) {
  let st;
  try { st = fs.statSync(arquivo); } catch (_) { res.writeHead(404); return res.end('nao achei'); }

  const tipo = TIPOS[path.extname(arquivo).toLowerCase()] || 'application/octet-stream';
  const faixa = req.headers.range;

  if (faixa) {
    const m = /bytes=(\d*)-(\d*)/.exec(faixa);
    const ini = m && m[1] ? Number(m[1]) : 0;
    const fim = m && m[2] ? Number(m[2]) : st.size - 1;
    res.writeHead(206, {
      'Content-Type': tipo,
      'Content-Range': 'bytes ' + ini + '-' + fim + '/' + st.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': fim - ini + 1,
    });
    return fs.createReadStream(arquivo, { start: ini, end: fim }).pipe(res);
  }

  const cabecalhos = { 'Content-Type': tipo, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' };
  // A janela nunca pode vir do cache: senao uma correcao no HTML nao chega
  // ate o usuario sem ele limpar o navegador na mao.
  if (/\.(html|js|css)$/i.test(arquivo)) cabecalhos['Cache-Control'] = 'no-store, must-revalidate';

  res.writeHead(200, cabecalhos);
  fs.createReadStream(arquivo).pipe(res);
}

/** Devolve um JPG gerado na hora, sem cache pra prévia nunca vir velha. */
function enviarImagem(res, arquivo) {
  const dados = fs.readFileSync(arquivo);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': dados.length,
    'Cache-Control': 'no-store',
  });
  res.end(dados);
}

// ---------------------------------------------------------------- login

/**
 * Sem AUTH_SENHA definida, o programa continua exatamente como sempre foi:
 * ninguem pede senha, uso 100% local. So quando a pessoa expõe isso na
 * internet (define a variavel) e que a porta da frente tranca sozinha.
 */
const AUTH_SENHA = process.env.AUTH_SENHA || '';
const sessoesValidas = new Set(); // tokens de sessao - em memoria, reseta a cada reinicio

function lerCookies(req) {
  const cru = req.headers.cookie || '';
  const mapa = {};
  for (const par of cru.split(';')) {
    const i = par.indexOf('=');
    if (i < 0) continue;
    mapa[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return mapa;
}

function estaLogado(req) {
  if (!AUTH_SENHA) return true;
  const token = lerCookies(req).sessao;
  return !!token && sessoesValidas.has(token);
}

function lerCorpoTexto(req, limite) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      if (dados.length > (limite || 1e5)) { req.destroy(); reject(new Error('corpo grande demais')); }
    });
    req.on('end', () => resolve(dados));
    req.on('error', reject);
  });
}

function paginaLogin(erro) {
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar</title><style>' +
    'body{background:#0b0e14;color:#e8eef6;font:15px/1.5 "Segoe UI",system-ui,sans-serif;' +
    'min-height:100vh;display:grid;place-items:center;margin:0}' +
    'form{background:#141922;border:1px solid #262e3b;border-radius:14px;padding:28px;width:100%;max-width:320px;box-sizing:border-box}' +
    'h1{font-size:19px;margin:0 0 18px;display:flex;align-items:center;gap:9px}' +
    'input{width:100%;padding:11px 12px;border-radius:10px;background:#1b212c;border:1px solid #333d4d;' +
    'color:#e8eef6;font:inherit;box-sizing:border-box;margin-bottom:12px}' +
    'button{width:100%;padding:12px;border:none;border-radius:10px;' +
    'background:linear-gradient(135deg,#ff4d6d,#ff8a5c);color:#fff;font:inherit;font-weight:650;cursor:pointer}' +
    '.erro{color:#fca5a5;font-size:13px;margin-bottom:12px}' +
    '</style></head><body>' +
    '<form method="POST" action="/api/login">' +
    '<h1>✂️ Cortador Automático</h1>' +
    (erro ? '<div class="erro">Senha incorreta.</div>' : '') +
    '<input type="password" name="senha" placeholder="Senha" autofocus required>' +
    '<button type="submit">Entrar</button>' +
    '</form></body></html>';
}

// ---------------------------------------------------------------- upload

// Sem isso, um servidor publico vira um jeito gratuito de qualquer um encher
// o disco de outra pessoa. 8 GB cobre um video de varias horas em boa qualidade.
const LIMITE_UPLOAD = Number(process.env.LIMITE_UPLOAD_MB || 8192) * 1024 * 1024;

function nomeDeArquivoSeguro(nome) {
  const base = path.basename(String(nome || 'video.mp4').replace(/[\\/]/g, '_'));
  const limpo = base.replace(/[^\w.\-À-ɏ ]+/g, '_').trim();
  return (limpo || 'video.mp4').slice(0, 120);
}

/** Um id curto por sessao de edicao, pra frame/previa de gente diferente nao se pisarem. */
function idDeSessao(bruto) {
  const s = String(bruto || 'local').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return s || 'local';
}

// ---------------------------------------------------------------- programas do windows

// Nao da pra confiar no PATH: dependendo de como o programa foi iniciado, o
// Node nao acha nem o powershell nem o explorer. Entao apontamos direto.
const SISTEMA = process.env.SystemRoot || 'C:\\Windows';

function programaDoWindows(relativo, alternativa) {
  const caminho = path.join(SISTEMA, relativo);
  return fs.existsSync(caminho) ? caminho : alternativa;
}

const POWERSHELL = programaDoWindows(
  path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'powershell.exe');
const EXPLORER = programaDoWindows('explorer.exe', 'explorer.exe');

// ---------------------------------------------------------------- dialogo nativo

/** Abre a janelinha do Windows pra escolher o video e devolve o caminho. */
function escolherArquivoNativo() {
  return new Promise((resolve) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      '$d.Title = "Escolha o video que voce quer cortar"',
      '$d.Filter = "Videos|*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v;*.wmv;*.flv;*.ts|Todos os arquivos|*.*"',
      '$d.Multiselect = $false',
      '$t = New-Object System.Windows.Forms.Form',
      '$t.TopMost = $true',
      'if ($d.ShowDialog($t) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
      '$t.Dispose()',
    ].join('; ');

    execFile(POWERSHELL, ['-NoProfile', '-STA', '-Command', script],
      { windowsHide: true, timeout: 300000 },
      (erro, saida) => {
        if (erro) return resolve(null);
        const caminho = String(saida || '').trim();
        resolve(caminho && fs.existsSync(caminho) ? caminho : null);
      });
  });
}

/** Quando o usuario arrasta o arquivo, o navegador so entrega o nome. Procuramos ele. */
function localizarPorNome(nome, tamanho) {
  const casa = os.homedir();
  const pastas = [
    path.join(casa, 'Downloads'),
    path.join(casa, 'Videos'),
    path.join(casa, 'Desktop'),
    path.join(casa, 'Documents'),
    path.join(casa, 'OneDrive', 'Desktop'),
    path.join(casa, 'OneDrive', 'Documentos'),
    path.join(casa, 'OneDrive', 'Vídeos'),
    RAIZ,
  ];

  const achados = [];
  for (const pasta of pastas) {
    const alvo = path.join(pasta, nome);
    try {
      const st = fs.statSync(alvo);
      if (st.isFile()) achados.push({ caminho: alvo, tamanho: st.size });
    } catch (_) { /* pasta pode nao existir */ }
  }

  if (!achados.length) return null;
  if (tamanho) {
    const exato = achados.find((a) => a.tamanho === tamanho);
    if (exato) return exato.caminho;
  }
  return achados[0].caminho;
}

// ---------------------------------------------------------------- trabalhos

function novoTrabalho() {
  const id = Math.random().toString(36).slice(2, 10);
  trabalhos.set(id, { eventos: [], ouvintes: new Set(), terminou: false });
  return id;
}

function emitir(id, evento) {
  const t = trabalhos.get(id);
  if (!t) return;
  t.eventos.push(evento);
  const linha = 'data: ' + JSON.stringify(evento) + '\n\n';
  for (const res of t.ouvintes) {
    try { res.write(linha); } catch (_) { t.ouvintes.delete(res); }
  }
  if (evento.tipo === 'fim' || evento.tipo === 'erro' || evento.tipo === 'baixado') {
    t.terminou = true;
    for (const res of t.ouvintes) { try { res.end(); } catch (_) {} }
    t.ouvintes.clear();
  }
}

// ---------------------------------------------------------------- rotas

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rota = url.pathname;

  try {
    // O login precisa ficar acessivel mesmo sem sessao valida, senao ninguem
    // consegue entrar. Todo o resto so roda com a porta destrancada.
    if (rota === '/api/login' && req.method === 'POST') {
      const corpoTexto = await lerCorpoTexto(req, 2000);
      const senha = new URLSearchParams(corpoTexto).get('senha') || '';
      if (AUTH_SENHA && senha === AUTH_SENHA) {
        const token = crypto.randomBytes(24).toString('hex');
        sessoesValidas.add(token);
        res.writeHead(302, {
          'Set-Cookie': 'sessao=' + token + '; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax',
          'Location': '/',
        });
        return res.end();
      }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(paginaLogin(true));
    }

    if (!estaLogado(req)) {
      if (rota.startsWith('/api/') || rota === '/arquivo') return json(res, 401, { erro: 'Faca login primeiro.' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(paginaLogin(false));
    }

    if (rota === '/' || rota === '/index.html') {
      return servirArquivo(req, res, path.join(__dirname, 'ui', 'index.html'));
    }

    // Arquivos da propria interface (lucide.js, css...). So o que esta na
    // pasta ui, e so o nome do arquivo - nada de subir diretorio.
    if (/^\/ui\/[\w.-]+$/.test(rota)) {
      return servirArquivo(req, res, path.join(__dirname, 'ui', path.basename(rota)));
    }

    // A janela usa isso pra mostrar o endereco do celular e o QR code, e pra
    // saber se pode oferecer o dialogo nativo (so faz sentido no Windows local).
    if (rota === '/api/rede') {
      const porta = servidor.address() ? servidor.address().port : PORTA_INICIAL;
      return json(res, 200, {
        naRede: NA_REDE,
        temDialogoNativo: process.platform === 'win32',
        porta: porta,
        enderecos: NA_REDE ? enderecosDaRede().map((ip) => 'http://' + ip + ':' + porta) : [],
      });
    }

    // So existe sentido no Windows rodando na mesma maquina que o navegador -
    // abre uma janela do Windows Forms. Em servidor/Linux isso nao existe.
    if (rota === '/api/escolher' && req.method === 'POST') {
      if (process.platform !== 'win32') return json(res, 200, { caminho: null });
      const caminho = await escolherArquivoNativo();
      return json(res, 200, { caminho });
    }

    if (rota === '/api/localizar' && req.method === 'POST') {
      if (process.platform !== 'win32') return json(res, 200, { caminho: null });
      const corpo = await lerCorpo(req);
      const caminho = localizarPorNome(corpo.nome || '', corpo.tamanho || 0);
      return json(res, 200, { caminho });
    }

    // Upload de verdade: o arquivo chega pelo corpo da requisicao e vai direto
    // pro disco, sem passar pela memoria inteiro. E o caminho que funciona de
    // qualquer aparelho - celular, notebook, outro computador na rede.
    if (rota === '/api/upload' && req.method === 'POST') {
      const tamanho = Number(req.headers['content-length'] || 0);
      if (tamanho > LIMITE_UPLOAD) {
        req.destroy();
        return json(res, 413, { erro: 'Vídeo grande demais (limite de ' + Math.round(LIMITE_UPLOAD / 1048576 / 1024) + ' GB).' });
      }

      const nome = nomeDeArquivoSeguro(url.searchParams.get('nome'));
      const pastaDestino = process.env.DADOS ? path.join(process.env.DADOS, 'baixados') : path.join(RAIZ, 'baixados');
      fs.mkdirSync(pastaDestino, { recursive: true });
      const destino = path.join(pastaDestino, Date.now() + '-' + nome);

      const id = novoTrabalho();
      json(res, 200, { id });

      let recebido = 0;
      const gravador = fs.createWriteStream(destino);
      req.on('data', (pedaco) => {
        recebido += pedaco.length;
        if (tamanho) {
          const pct = Math.min(99, Math.round((recebido / tamanho) * 100));
          emitir(id, { tipo: 'progresso', pct, etapa: 'enviando', msg: 'Enviando... ' + pct + '%' });
        }
      });
      req.on('error', (e) => { gravador.destroy(); emitir(id, { tipo: 'erro', msg: 'Envio interrompido: ' + e.message }); });
      gravador.on('error', (e) => emitir(id, { tipo: 'erro', msg: 'Falha ao salvar o arquivo: ' + e.message }));
      gravador.on('finish', () => emitir(id, { tipo: 'baixado', caminho: destino }));
      req.pipe(gravador);
      return;
    }

    if (rota === '/api/verificar' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const caminho = String(corpo.caminho || '').replace(/^"+|"+$/g, '').trim();
      const existe = !!caminho && fs.existsSync(caminho) && fs.statSync(caminho).isFile();
      return json(res, 200, { existe, caminho });
    }

    // Espia o link antes de baixar: titulo e duracao aparecem na hora.
    if (rota === '/api/espiar' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const url = String(corpo.url || '').trim();
      if (!baixador.pareceLink(url)) return json(res, 400, { erro: 'Isso não parece um link.' });
      try {
        return json(res, 200, await baixador.espiar(url));
      } catch (e) {
        return json(res, 400, { erro: e.message });
      }
    }

    // Baixa o video do link. Vira um trabalho com progresso, igual ao corte.
    if (rota === '/api/baixar' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const url = String(corpo.url || '').trim();
      if (!baixador.pareceLink(url)) return json(res, 400, { erro: 'Isso não parece um link.' });

      const id = novoTrabalho();
      json(res, 200, { id });

      baixador.baixar(url, { limiteAltura: Number(corpo.limiteAltura) },
        (frac, msg) => emitir(id, {
          tipo: 'progresso', pct: Math.round(frac * 100), etapa: 'baixando', msg,
        }))
        .then((caminho) => emitir(id, { tipo: 'baixado', caminho }))
        .catch((e) => emitir(id, { tipo: 'erro', msg: e.message || String(e) }));
      return;
    }

    // Mostra na hora como o sistema entendeu o que a pessoa escreveu.
    if (rota === '/api/entender' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const { interpretar } = require('./intencao');
      return json(res, 200, interpretar(corpo.descricao || ''));
    }

    // Duracao e resolucao - a janela usa pra montar o slider de tempo.
    if (rota === '/api/info' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      if (!corpo.video || !fs.existsSync(corpo.video)) return json(res, 400, { erro: 'video nao encontrado' });
      try {
        const info = await media.inspecionar(corpo.video);
        return json(res, 200, info);
      } catch (e) {
        return json(res, 400, { erro: 'nao consegui ler esse video: ' + e.message });
      }
    }

    // Procura a webcam sozinho. Marcar essa caixa no canto errado estraga
    // todos os clipes de uma vez e em silencio, entao vale tentar adivinhar
    // e deixar a pessoa so confirmar na previa.
    if (rota === '/api/achar-webcam' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      if (!corpo.video || !fs.existsSync(corpo.video)) return json(res, 400, { erro: 'video nao encontrado' });
      try {
        const achado = await media.acharWebcam(corpo.video, Number(corpo.duracao) || 0);
        return json(res, 200, achado || { achou: false });
      } catch (e) {
        return json(res, 200, { achou: false, erro: e.message });
      }
    }

    // Frame cru do video, pro usuario marcar onde esta a webcam e o jogo.
    // O id de sessao evita que a previa de uma pessoa sobrescreva a da outra
    // quando o servidor atende mais de um navegador ao mesmo tempo.
    if (rota === '/api/frame' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      if (!corpo.video || !fs.existsSync(corpo.video)) return json(res, 400, { erro: 'video nao encontrado' });

      fs.mkdirSync(TRABALHO, { recursive: true });
      const alvo = path.join(TRABALHO, 'frame-' + idDeSessao(corpo.sid) + '.jpg');
      await media.gerarFrame(corpo.video, Number(corpo.segundo) || 0, alvo, 960);
      return enviarImagem(res, alvo);
    }

    // Frame ja montado no formato final, pra conferir antes de gerar tudo.
    if (rota === '/api/previa' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      if (!corpo.video || !fs.existsSync(corpo.video)) return json(res, 400, { erro: 'video nao encontrado' });

      fs.mkdirSync(TRABALHO, { recursive: true });
      const alvo = path.join(TRABALHO, 'previa-' + idDeSessao(corpo.sid) + '.jpg');
      await media.gerarPrevia(corpo.video, Number(corpo.segundo) || 0,
        corpo.formato || 'vertical', corpo.recorte, alvo);
      return enviarImagem(res, alvo);
    }

    if (rota === '/api/processar' && req.method === 'POST') {
      // Duas transcricoes ao mesmo tempo nao dividem CPU de graca: as duas
      // ficam mais lentas e a memoria pode estourar. Um job de cada vez.
      if (jobAtivo) return json(res, 429, { erro: 'Já tem um vídeo sendo processado. Espere terminar antes de mandar outro.' });

      const opcoes = await lerCorpo(req);
      const id = novoTrabalho();
      json(res, 200, { id });

      jobAtivo = true;
      processar(opcoes, (ev) => emitir(id, ev))
        .catch((e) => emitir(id, { tipo: 'erro', msg: e.message || String(e) }))
        .finally(() => { jobAtivo = false; });
      return;
    }

    if (rota === '/api/eventos') {
      const id = url.searchParams.get('id');
      const t = trabalhos.get(id);
      if (!t) { res.writeHead(404); return res.end(); }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // manda o que ja passou, pra quem reconectar nao perder nada
      for (const ev of t.eventos) res.write('data: ' + JSON.stringify(ev) + '\n\n');
      if (t.terminou) return res.end();

      t.ouvintes.add(res);
      req.on('close', () => t.ouvintes.delete(res));
      return;
    }

    if (rota === '/api/abrir' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const alvo = String(corpo.caminho || SAIDA);
      // No Windows local, abre o Explorer de verdade. Em servidor isso nao
      // existe (abriria uma janela na maquina do servidor, que ninguem ve) -
      // devolvemos o link de download pra pessoa baixar o clipe direto.
      if (process.platform === 'win32' && fs.existsSync(alvo)) {
        const st = fs.statSync(alvo);
        if (st.isDirectory()) execFile(EXPLORER, [alvo], () => {});
        else execFile(EXPLORER, ['/select,', alvo], () => {});
      }
      return json(res, 200, { ok: true, url: '/arquivo?p=' + encodeURIComponent(alvo) });
    }

    if (rota === '/arquivo') {
      const p = url.searchParams.get('p');
      if (!p) { res.writeHead(400); return res.end(); }
      const resolvido = path.resolve(p);
      const base = path.resolve(SAIDA);
      // path.relative em vez de startsWith: no Linux o filesystem e
      // case-sensitive (o toLowerCase de antes tanto deixava passar quanto
      // barrava por engano), e sem checar o separador um irmao do tipo
      // "saida-publico" passaria no startsWith ingenuo.
      const rel = path.relative(base, resolvido);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        res.writeHead(403); return res.end('fora da pasta de saida');
      }
      return servirArquivo(req, res, resolvido);
    }

    if (rota === '/api/saida') {
      return json(res, 200, { pasta: SAIDA });
    }

    res.writeHead(404);
    res.end('nao achei');
  } catch (e) {
    json(res, 500, { erro: e.message || String(e) });
  }
});

// ---------------------------------------------------------------- subir

/** IPs da maquina na rede local - e por eles que o celular acha o programa. */
function enderecosDaRede() {
  const saida = [];
  const redes = os.networkInterfaces();
  for (const nome of Object.keys(redes)) {
    for (const i of redes[nome] || []) {
      if (i.family === 'IPv4' && !i.internal) saida.push(i.address);
    }
  }
  return saida;
}

function subir(porta, tentativas) {
  servidor.listen(porta, HOST);
  servidor.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tentativas > 0) {
      servidor.removeAllListeners('listening');
      subir(porta + 1, tentativas - 1);
    } else {
      console.error('Nao consegui subir o servidor:', e.message);
      process.exit(1);
    }
  });
  servidor.once('listening', () => {
    const endereco = 'http://127.0.0.1:' + porta;
    console.log('');
    console.log('  Cortador automatico rodando em ' + endereco);

    if (NA_REDE) {
      for (const ip of enderecosDaRede()) {
        console.log('  No celular (mesma rede wi-fi):  http://' + ip + ':' + porta);
      }
    } else {
      console.log('  Para abrir no celular, rode:  iniciar-no-celular.bat');
    }

    console.log('  Deixe esta janela preta aberta enquanto usa o programa.');
    console.log('');
    if (process.env.NAO_ABRIR !== '1') abrirJanela(endereco);
  });
}

/** Abre em modo app (sem barra de endereco) - parece um programa de verdade. */
function abrirJanela(endereco) {
  if (process.platform !== 'win32') return; // servidor nao tem tela pra abrir nada

  const navegadores = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  for (const nav of navegadores) {
    if (fs.existsSync(nav)) {
      spawn(nav, ['--app=' + endereco, '--window-size=1180,880'], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
  }
  execFile('cmd', ['/c', 'start', '', endereco], { windowsHide: true }, () => {});
}

subir(PORTA_INICIAL, 20);
