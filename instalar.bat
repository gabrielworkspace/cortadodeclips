@echo off
chcp 65001 >nul
title Instalador - Cortador Automatico
cd /d "%~dp0"

echo.
echo  ============================================================
echo    INSTALADOR DO CORTADOR AUTOMATICO
echo  ============================================================
echo.
echo   Isso instala o que o programa precisa pra funcionar:
echo     - ffmpeg  (corta e monta os videos)
echo     - Python  (motor da transcricao)
echo     - o modelo que le a fala do video
echo.
echo   Pode demorar uns 10 minutos na primeira vez.
echo   Depois disso voce so usa o iniciar.bat.
echo.
pause

echo.
echo  [1/5] Instalando o ffmpeg...
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements --silent

echo.
echo  [2/5] Instalando o Python...
winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements --silent --scope user

echo.
echo  [3/6] Instalando o baixador de videos (yt-dlp)...
winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements --silent

echo.
echo  [4/6] Procurando o Python...
set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not exist "%PY%" set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not exist "%PY%" goto sempython

echo        Achei: %PY%

echo.
echo  [5/6] Instalando o motor de transcricao...
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install faster-whisper

echo.
echo  [6/6] Baixando o modelo de reconhecimento de fala...
"%PY%" -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root=r'%~dp0modelos'); print('   modelo pronto')"

echo.
echo  Instalando as bibliotecas do Node...
call npm install

echo.
echo  ============================================================
echo    TUDO PRONTO!
echo.
echo    Agora e so dar dois cliques no arquivo  iniciar.bat
echo  ============================================================
echo.
pause
exit /b 0

:sempython
echo.
echo  [ERRO] Nao achei o Python depois de instalar.
echo  Feche esta janela, abra ela de novo e rode o instalar.bat mais uma vez.
echo  (O Windows as vezes so reconhece o Python numa janela nova.)
echo.
pause
