@echo off
rem Igual ao iniciar.bat, mas liberando o acesso pela rede wi-fi de casa,
rem pra abrir o programa no celular. So funciona com o PC ligado.
set "PATH=%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
chcp 65001 >nul 2>nul
title Cortador Automatico (com celular)
cd /d "%~dp0"

set "REDE=1"

echo.
echo   Iniciando com acesso pelo celular...
echo.
echo   O endereco do celular aparece abaixo em alguns segundos.
echo   O celular precisa estar no MESMO wi-fi que este PC.
echo.
echo   NAO FECHE ESTA JANELA PRETA enquanto estiver usando.
echo.

set "NODE="
node --version >nul 2>nul
if not errorlevel 1 set "NODE=node"

if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE goto semnode

if not exist "node_modules" (
  echo   Primeira vez rodando: instalando as bibliotecas...
  call npm install --silent
  echo.
)

"%NODE%" src\server.js
goto fim

:semnode
echo   [ERRO] Nao encontrei o Node.js nesta maquina.
echo   Baixe e instale em:  https://nodejs.org
echo.

:fim
echo.
echo   O programa foi encerrado.
pause
