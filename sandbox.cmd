@echo off
rem Double-click this file to run the app on this computer.
rem It uses the settings in .env (the TEST database) and opens the page in
rem your browser when it's ready. Close this window to stop.
rem
rem It brings its own tools (downloaded on first run into the "tools" folder
rem and, for Azure Functions Core Tools, into %USERPROFILE%\.swa). PATH is
rem reset below, so other Node.js or Azure tools on this PC are never used.
cd /d "%~dp0"
setlocal

set NODE_VERSION=22.23.2
set SWA_VERSION=2.0.10

if not exist .env (
  echo.
  echo Missing .env. See README.
  echo.
  pause
  exit /b 1
)

set TOOLS=%~dp0tools
set PATH=%TOOLS%\node;%TOOLS%\swa\node_modules\.bin;%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\WindowsPowerShell\v1.0
if not exist "%TOOLS%" mkdir "%TOOLS%"

if not exist "%TOOLS%\node\node.exe" (
  echo Downloading Node.js %NODE_VERSION%, first run only...
  curl -fL -o "%TOOLS%\node.zip" https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip || goto failed
  tar -xf "%TOOLS%\node.zip" -C "%TOOLS%" || goto failed
  ren "%TOOLS%\node-v%NODE_VERSION%-win-x64" node || goto failed
  del "%TOOLS%\node.zip"
)

if not exist "%TOOLS%\swa\node_modules\.bin\swa.cmd" (
  echo Installing the Azure Static Web Apps tool %SWA_VERSION%, first run only...
  if not exist "%TOOLS%\swa" mkdir "%TOOLS%\swa"
  pushd "%TOOLS%\swa"
  echo {}> package.json
  call npm install --no-fund --no-audit @azure/static-web-apps-cli@%SWA_VERSION% || goto failed
  popd
)

echo Installing the API's packages...
pushd api
call npm install --no-fund --no-audit || goto failed
popd

echo Starting... the page opens in your browser when it's ready.
echo Close this window to stop.
call swa start public --api-location api --open || goto failed
exit /b 0

:failed
echo.
echo SANDBOX FAILED TO START. Read the messages above (or paste them into Claude/ChatGPT).
pause
exit /b 1
