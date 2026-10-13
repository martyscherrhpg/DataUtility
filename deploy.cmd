@echo off
rem Double-click this file to publish the app to Azure.
rem It needs a file named deploy-token.txt next to it. See README.
rem
rem It brings its own tools (downloaded on first run into the "tools" folder
rem and, for Azure Functions Core Tools, into %USERPROFILE%\.swa). PATH is
rem reset below, so other Node.js or Azure tools on this PC are never used.
cd /d "%~dp0"
setlocal

set NODE_VERSION=22.23.2
set SWA_VERSION=2.0.10

if not exist deploy-token.txt (
  echo.
  echo Missing deploy-token.txt. See README.
  echo.
  pause
  exit /b 1
)
set /p SWA_CLI_DEPLOYMENT_TOKEN=<deploy-token.txt

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
call npm install --omit=dev --no-fund --no-audit || goto failed
popd

echo Uploading to Azure...
call swa deploy public --api-location api --api-language node --api-version 22 --env production || goto failed

echo.
echo DONE. The site updates within a minute or two.
pause
exit /b 0

:failed
echo.
echo DEPLOY FAILED. Read the messages above (or paste them into Claude/ChatGPT).
pause
exit /b 1
